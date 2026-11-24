import type { Platform } from '@tessera/ui/downloads';

import type { Profile } from './identity.ts';
import { randomToken } from './session.ts';
import type { Share } from './shares.ts';

export interface User {
  id: string;
  email: string;
  name: string | null;
  role: 'member' | 'admin';
}

export type ApplicationStatus = 'pending' | 'approved' | 'declined';

export type Access = 'full' | 'pending' | 'declined' | 'none';

export interface Standing {
  access: Access;
  entitlements: string[];
}

export interface Checkin {
  appVersion: string;
  platform: string;
  arch: string;
  channel: string;
}

export interface Answers {
  propFirm: string;
  platform: Platform;
  trading: string;
}

export interface Application {
  propFirm: string | null;
  platform: Platform | null;
  trading: string | null;
  status: ApplicationStatus;
  createdAt: string;
}

interface ApprovalEmail {
  state: 'sending' | 'sent' | 'failed';
  at: string;
  error: string | null;
}

type InviteState = { kind: 'open' } | { kind: 'used'; at: string; by: string } | { kind: 'revoked'; at: string };

export interface Invite {
  token: string;
  email: string;
  createdAt: string;
  state: InviteState;
}

export type InviteResult = { kind: 'invite'; invite: Invite } | { kind: 'account'; user: User };

export interface SignIn {
  user: User;
  invited: boolean;
}

export interface Applicant {
  user: User;
  access: Access;
  since: string;
  invitedAt: string | null;
  application: (Omit<Application, 'createdAt'> & { decidedAt: string | null }) | null;
  approvalEmail: ApprovalEmail | null;
  lastCheckin: (Checkin & { at: string }) | null;
}

interface ApplicantRow {
  id: string;
  email: string;
  name: string | null;
  role: User['role'];
  created_at: string;
  prop_firm: string | null;
  platform: Platform | null;
  trading: string | null;
  status: ApplicationStatus | null;
  applied_at: string | null;
  decided_at: string | null;
  approval_email: ApprovalEmail['state'] | null;
  approval_email_at: string | null;
  approval_email_error: string | null;
  early_access: number;
  invited_at: string | null;
  checkin_at: string | null;
  app_version: string | null;
  checkin_platform: string | null;
  arch: string | null;
  channel: string | null;
}

interface InviteRow {
  id: string;
  email: string;
  created_at: string;
  used_by: string | null;
  used_at: string | null;
  revoked_at: string | null;
}

const INVITE_COLUMNS = 'id, email, created_at, used_by, used_at, revoked_at';

const OPEN = 'used_at IS NULL AND revoked_at IS NULL';

export function store(db: D1Database) {
  const upsert = (profile: Profile, at: string) =>
    db
      .prepare(
        `INSERT INTO users (id, subject, email, name, created_at, seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT (subject) DO UPDATE SET
           email = excluded.email, name = COALESCE(excluded.name, users.name), seen_at = excluded.seen_at
         RETURNING id, email, name, role`,
      )
      .bind(newId('usr'), profile.subject, profile.email, profile.name, at);

  return {
    async signIn(profile: Profile, now: Date): Promise<SignIn> {
      const at = now.toISOString();
      if (!profile.emailVerified) {
        const row = await upsert(profile, at).first<User>();
        if (row === null) throw new Error('upsert returned no user');
        return { user: row, invited: false };
      }
      const person = '(SELECT id FROM users WHERE subject = ?1)';
      const [user, claimed] = await db.batch<User | { id: string }>([
        upsert(profile, at),
        db
          .prepare(
            `UPDATE invites SET used_by = ${person}, used_at = ?2
             WHERE email = lower(?3) AND ${OPEN}
               AND NOT EXISTS (SELECT 1 FROM applications WHERE user_id = ${person})
             RETURNING id`,
          )
          .bind(profile.subject, at, profile.email),
        db
          .prepare(
            `INSERT INTO applications (user_id, status, created_at, decided_at, decided_by)
             SELECT used_by, 'approved', used_at, created_at, created_by FROM invites
             WHERE used_by = ${person} AND used_at = ?2
             ON CONFLICT (user_id) DO NOTHING`,
          )
          .bind(profile.subject, at),
        db
          .prepare(
            `INSERT INTO entitlements (user_id, key, source, granted_at)
             SELECT used_by, 'early_access', 'invite', used_at FROM invites
             WHERE used_by = ${person} AND used_at = ?2
             ON CONFLICT (user_id, key) DO NOTHING`,
          )
          .bind(profile.subject, at),
      ]);
      const row = (user?.results as User[] | undefined)?.[0];
      if (row === undefined) throw new Error('upsert returned no user');
      return { user: row, invited: (claimed?.results.length ?? 0) > 0 };
    },

    async invite(email: string, by: string, now: Date): Promise<InviteResult> {
      const [, person, open] = await db.batch<User | InviteRow>([
        db
          .prepare(
            `INSERT INTO invites (id, email, created_by, created_at)
             SELECT ?1, ?2, ?3, ?4 WHERE NOT EXISTS (SELECT 1 FROM users WHERE lower(email) = ?2)
             ON CONFLICT (email) WHERE ${OPEN} DO NOTHING`,
          )
          .bind(randomToken(), email, by, now.toISOString()),
        db.prepare('SELECT id, email, name, role FROM users WHERE lower(email) = ?1 LIMIT 1').bind(email),
        db.prepare(`SELECT ${INVITE_COLUMNS} FROM invites WHERE email = ?1 AND ${OPEN}`).bind(email),
      ]);
      const user = (person?.results as User[] | undefined)?.[0];
      if (user !== undefined) return { kind: 'account', user };
      const row = (open?.results as InviteRow[] | undefined)?.[0];
      if (row === undefined) throw new Error('invite was not created');
      return { kind: 'invite', invite: inviteOf(row) };
    },

    async openInvites(): Promise<Invite[]> {
      const { results } = await db
        .prepare(`SELECT ${INVITE_COLUMNS} FROM invites WHERE ${OPEN} ORDER BY created_at DESC, id`)
        .all<InviteRow>();
      return results.map(inviteOf);
    },

    async inviteByToken(token: string): Promise<Invite | null> {
      const row = await db
        .prepare(`SELECT ${INVITE_COLUMNS} FROM invites WHERE id = ?1`)
        .bind(token)
        .first<InviteRow>();
      return row === null ? null : inviteOf(row);
    },

    async revokeInvite(token: string, now: Date): Promise<void> {
      await db
        .prepare(`UPDATE invites SET revoked_at = ?2 WHERE id = ?1 AND ${OPEN}`)
        .bind(token, now.toISOString())
        .run();
    },

    userBySubject(subject: string): Promise<User | null> {
      return db.prepare('SELECT id, email, name, role FROM users WHERE subject = ?1').bind(subject).first<User>();
    },

    userById(id: string): Promise<User | null> {
      return db.prepare('SELECT id, email, name, role FROM users WHERE id = ?1').bind(id).first<User>();
    },

    async standing(userId: string): Promise<Standing> {
      const [entitlements, application] = await db.batch<{ key: string } | { status: ApplicationStatus }>([
        db.prepare('SELECT key FROM entitlements WHERE user_id = ?1 ORDER BY key').bind(userId),
        db.prepare('SELECT status FROM applications WHERE user_id = ?1').bind(userId),
      ]);
      const keys = (entitlements?.results as { key: string }[] | undefined)?.map((row) => row.key) ?? [];
      const status = (application?.results as { status: ApplicationStatus }[] | undefined)?.[0]?.status;
      return { access: accessOf(keys, status), entitlements: keys };
    },

    async application(userId: string): Promise<Application | null> {
      const row = await db
        .prepare(
          `SELECT prop_firm AS propFirm, platform, trading, status, created_at AS createdAt
           FROM applications WHERE user_id = ?1`,
        )
        .bind(userId)
        .first<Application>();
      return row;
    },

    async apply(userId: string, answers: Answers, name: string | null, now: Date): Promise<void> {
      const statements = [
        db
          .prepare(
            `INSERT INTO applications (user_id, prop_firm, platform, trading, status, created_at)
             VALUES (?1, ?2, ?3, ?4, 'pending', ?5)
             ON CONFLICT (user_id) DO UPDATE SET
               prop_firm = excluded.prop_firm, platform = excluded.platform, trading = excluded.trading
             WHERE applications.status = 'pending'`,
          )
          .bind(userId, answers.propFirm, answers.platform, answers.trading, now.toISOString()),
      ];
      if (name !== null) statements.push(db.prepare('UPDATE users SET name = ?2 WHERE id = ?1').bind(userId, name));
      await db.batch(statements);
    },

    async applicants(): Promise<Applicant[]> {
      const { results } = await db
        .prepare(
          `SELECT u.id, u.email, u.name, u.role, u.created_at,
             a.prop_firm, a.platform, a.trading, a.status, a.created_at AS applied_at, a.decided_at,
             a.approval_email, a.approval_email_at, a.approval_email_error,
             EXISTS (SELECT 1 FROM entitlements e WHERE e.user_id = u.id AND e.key = 'early_access') AS early_access,
             (SELECT i.created_at FROM invites i WHERE i.used_by = u.id ORDER BY i.used_at LIMIT 1) AS invited_at,
             c.at AS checkin_at, c.app_version, c.platform AS checkin_platform, c.arch, c.channel
           FROM users u
           LEFT JOIN applications a ON a.user_id = u.id
           LEFT JOIN checkins c ON c.id = (
             SELECT id FROM checkins WHERE user_id = u.id ORDER BY at DESC, id DESC LIMIT 1
           )
           ORDER BY COALESCE(a.created_at, u.created_at) DESC, u.id`,
        )
        .all<ApplicantRow>();
      return results.map(applicantOf);
    },

    async approve(userId: string, by: string, now: Date): Promise<void> {
      const at = now.toISOString();
      await db.batch([
        db
          .prepare(
            `INSERT INTO applications (user_id, status, created_at, decided_at, decided_by)
             VALUES (?1, 'approved', ?3, ?3, ?2)
             ON CONFLICT (user_id) DO UPDATE SET
               status = 'approved', decided_at = excluded.decided_at, decided_by = excluded.decided_by
             WHERE applications.status != 'approved'`,
          )
          .bind(userId, by, at),
        db
          .prepare(
            `INSERT INTO entitlements (user_id, key, source, granted_at) VALUES (?1, 'early_access', 'approval', ?2)
             ON CONFLICT (user_id, key) DO NOTHING`,
          )
          .bind(userId, at),
      ]);
    },

    async decline(userId: string, by: string, now: Date): Promise<void> {
      await db
        .prepare(
          `INSERT INTO applications (user_id, status, created_at, decided_at, decided_by)
           VALUES (?1, 'declined', ?3, ?3, ?2)
           ON CONFLICT (user_id) DO UPDATE SET
             status = 'declined', decided_at = excluded.decided_at, decided_by = excluded.decided_by
           WHERE applications.status = 'pending'`,
        )
        .bind(userId, by, now.toISOString())
        .run();
    },

    async claimApprovalEmail(userId: string, now: Date, resend?: { staleBefore: Date }): Promise<boolean> {
      const claim = `UPDATE applications SET approval_email = 'sending', approval_email_at = ?2, approval_email_error = NULL
        WHERE user_id = ?1 AND status = 'approved' AND `;
      const statement =
        resend === undefined
          ? db.prepare(`${claim} approval_email IS NULL`).bind(userId, now.toISOString())
          : db
              .prepare(
                `${claim} (approval_email = 'failed' OR (approval_email = 'sending' AND approval_email_at < ?3))`,
              )
              .bind(userId, now.toISOString(), resend.staleBefore.toISOString());
      const result = await statement.run();
      return result.meta.changes === 1;
    },

    async finishApprovalEmail(userId: string, error: string | null, now: Date): Promise<void> {
      await db
        .prepare(
          `UPDATE applications SET approval_email = ?2, approval_email_at = ?3, approval_email_error = ?4
           WHERE user_id = ?1`,
        )
        .bind(userId, error === null ? 'sent' : 'failed', now.toISOString(), error)
        .run();
    },

    async checkin(userId: string, checkin: Checkin, now: Date): Promise<void> {
      const at = now.toISOString();
      await db.batch([
        db
          .prepare(
            'INSERT INTO checkins (user_id, at, app_version, platform, arch, channel) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
          )
          .bind(userId, at, checkin.appVersion, checkin.platform, checkin.arch, checkin.channel),
        db.prepare('UPDATE users SET seen_at = ?2 WHERE id = ?1').bind(userId, at),
      ]);
    },

    async addShare(share: Share): Promise<void> {
      await db
        .prepare(
          `INSERT INTO shares (id, user_id, kind, title, image_type, width, height, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
        )
        .bind(
          share.id,
          share.userId,
          share.kind,
          share.title,
          share.imageType,
          share.width,
          share.height,
          share.createdAt,
        )
        .run();
    },

    async share(id: string): Promise<Share | null> {
      const row = await db.prepare(`SELECT ${SHARE_COLUMNS} FROM shares WHERE id = ?1`).bind(id).first<ShareRow>();
      return row === null ? null : shareOf(row);
    },

    async sharesOf(userId: string): Promise<Share[]> {
      const { results } = await db
        .prepare(`SELECT ${SHARE_COLUMNS} FROM shares WHERE user_id = ?1 ORDER BY created_at DESC, id`)
        .bind(userId)
        .all<ShareRow>();
      return results.map(shareOf);
    },

    async removeShare(userId: string, id: string): Promise<boolean> {
      const { meta } = await db.prepare('DELETE FROM shares WHERE id = ?1 AND user_id = ?2').bind(id, userId).run();
      return meta.changes > 0;
    },
  };
}

interface ShareRow {
  id: string;
  user_id: string;
  kind: Share['kind'];
  title: string;
  image_type: Share['imageType'];
  width: number;
  height: number;
  created_at: string;
}

const SHARE_COLUMNS = 'id, user_id, kind, title, image_type, width, height, created_at';

function shareOf(row: ShareRow): Share {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    title: row.title,
    imageType: row.image_type,
    width: row.width,
    height: row.height,
    createdAt: row.created_at,
  };
}

export type Store = ReturnType<typeof store>;

export function accessOf(entitlements: readonly string[], application: ApplicationStatus | undefined): Access {
  if (entitlements.includes('early_access')) return 'full';
  if (application === 'pending' || application === 'declined') return application;
  return 'none';
}

function applicantOf(row: ApplicantRow): Applicant {
  return {
    user: { id: row.id, email: row.email, name: row.name, role: row.role },
    access: accessOf(row.early_access === 1 ? ['early_access'] : [], row.status ?? undefined),
    since: row.applied_at ?? row.created_at,
    invitedAt: row.invited_at,
    application:
      row.status === null
        ? null
        : {
            propFirm: row.prop_firm,
            platform: row.platform,
            trading: row.trading,
            status: row.status,
            decidedAt: row.decided_at,
          },
    approvalEmail:
      row.approval_email === null || row.approval_email_at === null
        ? null
        : { state: row.approval_email, at: row.approval_email_at, error: row.approval_email_error },
    lastCheckin:
      row.checkin_at === null
        ? null
        : {
            at: row.checkin_at,
            appVersion: row.app_version ?? '',
            platform: row.checkin_platform ?? '',
            arch: row.arch ?? '',
            channel: row.channel ?? '',
          },
  };
}

function inviteOf(row: InviteRow): Invite {
  const base = { token: row.id, email: row.email, createdAt: row.created_at };
  if (row.used_by !== null && row.used_at !== null) {
    return { ...base, state: { kind: 'used', at: row.used_at, by: row.used_by } };
  }
  if (row.revoked_at !== null) return { ...base, state: { kind: 'revoked', at: row.revoked_at } };
  return { ...base, state: { kind: 'open' } };
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}
