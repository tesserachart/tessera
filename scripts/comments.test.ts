import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repo = resolve(import.meta.dirname, '..');
let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'comments-'));
  mkdirSync(join(work, 'scripts'));
  copyFileSync(join(repo, 'scripts/comments.ts'), join(work, 'scripts/comments.ts'));
  symlinkSync(join(repo, 'node_modules'), join(work, 'node_modules'));
  execFileSync('git', ['init', '-q'], { cwd: work });
});

afterEach(() => rmSync(work, { recursive: true, force: true }));

function statuses(rust: string): Record<string, string> {
  writeFileSync(join(work, 'lib.rs'), rust);
  const listed = execFileSync(process.execPath, ['scripts/comments.ts', 'list'], { cwd: work, encoding: 'utf8' });
  return Object.fromEntries(
    [...listed.matchAll(/^(\w+)\s+lib\.rs:\d+\s+\/\/\/ (.*)$/gm)].map(([, status, text]) => [text!, status!]),
  );
}

describe('Rust doc comments', () => {
  it('exempts what schemars and clap hand to an agent or a user', () => {
    expect(
      statuses(`#[derive(Serialize, TS, JsonSchema)]
pub struct Input {
    /// Bars before the event, at most 500.
    pub before: u32,
}

#[derive(Parser)]
struct Cli {
    /// Serve on this port instead of a free one.
    port: u16,
}
`),
    ).toEqual({
      'Bars before the event, at most 500.': 'contract',
      'Serve on this port instead of a free one.': 'contract',
    });
  });

  it('does not exempt a doc that only reaches the generated TypeScript', () => {
    expect(
      statuses(`#[derive(Serialize, TS)]
pub struct Event {
    /// Sent once the bar closes.
    pub closed: bool,
}
`),
    ).toEqual({ 'Sent once the bar closes.': 'new' });
  });

  it('does not exempt a variant or type doc that restates its name', () => {
    expect(
      statuses(`/// One order.
#[derive(Serialize, JsonSchema)]
pub struct Order {
    pub status: Status,
}

#[derive(Serialize, JsonSchema)]
pub enum Status {
    /// Cancelled.
    Cancelled,
    /// Risk tier.
    Tier(RiskTier),
    /// This week.
    Week,
}
`),
    ).toEqual({ 'One order.': 'new', 'Cancelled.': 'new', 'Risk tier.': 'new', 'This week.': 'contract' });
  });

  it('exempts every field doc, since each tool schema property carries a description', () => {
    expect(
      statuses(`#[derive(Serialize, JsonSchema)]
pub struct Order {
    /// The account id.
    pub account_id: String,
    /// Optional note.
    pub note: Option<String>,
}
`),
    ).toEqual({ 'The account id.': 'contract', 'Optional note.': 'contract' });
  });
});
