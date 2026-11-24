use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tessera_core::Timestamp;
use tessera_core::b64;
use tessera_core::ids::SessionId;
use tessera_protocol::agent::{
    ATTACHMENT_MAX_CHUNK_BYTES, ATTACHMENT_MAX_FILE_BYTES, ATTACHMENT_MAX_IMAGE_BYTES,
    ATTACHMENT_MAX_IMAGE_BYTES_PER_MESSAGE, ATTACHMENT_MAX_PER_MESSAGE, AgentUploadAttachmentInput,
    AgentUploadAttachmentOutput, Attachment, AttachmentKind,
};
use tessera_tools::ToolError;

use crate::child_env::create_private_dir;
use crate::provider::{TurnAttachment, TurnContent};

pub const PENDING_TTL_NS: i64 = 24 * 60 * 60 * 1_000_000_000;
pub const INLINE_FILE_MAX_CHARS: usize = 100_000;
pub const INLINE_TOTAL_MAX_CHARS: usize = 200_000;
const NAME_MAX_CHARS: usize = 200;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Content {
    Image,
    Pdf,
    Text,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Meta {
    id: String,
    name: String,
    mime_type: String,
    size_bytes: u64,
    kind: AttachmentKind,
    received: u64,
    content: Option<Content>,
    created_at: i64,
    session: Option<String>,
}

impl Meta {
    fn attachment(&self) -> Attachment {
        Attachment {
            kind: self.kind,
            label: self.name.clone(),
            reference: None,
            id: Some(self.id.clone()),
            mime_type: Some(self.mime_type.clone()),
            size_bytes: Some(self.size_bytes),
        }
    }

    fn whole(&self) -> bool {
        self.received == self.size_bytes && self.content.is_some()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Resolved {
    pub attachment: Attachment,
    pub turn: TurnAttachment,
}

#[derive(Clone, Debug)]
pub struct AttachmentStore {
    dir: PathBuf,
}

fn invalid(message: impl Into<String>) -> ToolError {
    ToolError::invalid_input(message)
}

fn internal(e: impl std::fmt::Display) -> ToolError {
    ToolError::internal(e.to_string())
}

fn valid_id(id: &str) -> bool {
    id.strip_prefix("att_").is_some_and(|hex| {
        hex.len() == 32
            && hex
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

pub fn image_type(mime: &str) -> Option<&'static str> {
    match mime.trim().to_ascii_lowercase().as_str() {
        "image/png" => Some("image/png"),
        "image/jpeg" | "image/jpg" => Some("image/jpeg"),
        "image/gif" => Some("image/gif"),
        "image/webp" => Some("image/webp"),
        _ => None,
    }
}

fn sniff_image(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

fn is_text(bytes: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return false;
    };
    if bytes.contains(&0) {
        return false;
    }
    let (mut chars, mut control) = (0usize, 0usize);
    for c in text.chars() {
        chars += 1;
        if (c.is_control() && !matches!(c, '\t' | '\n' | '\r' | '\x0c' | '\x1b')) || c == '\u{fffd}'
        {
            control += 1;
        }
    }
    control * 100 <= chars
}

fn clean_name(name: &str) -> String {
    let last = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let clean: String = last
        .chars()
        .filter(|c| !c.is_control())
        .take(NAME_MAX_CHARS)
        .collect();
    let clean = clean.trim();
    if clean.is_empty() {
        "attachment".into()
    } else {
        clean.to_owned()
    }
}

fn mib(bytes: u64) -> String {
    format!("{} MiB", bytes / (1024 * 1024))
}

impl AttachmentStore {
    pub fn open(dir: impl AsRef<Path>) -> std::io::Result<Self> {
        let dir = dir.as_ref().to_path_buf();
        create_private_dir(&dir)?;
        let store = Self { dir };
        store.sweep(Timestamp::now());
        Ok(store)
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn data_path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.data"))
    }

    fn meta_path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.json"))
    }

    fn read_meta(&self, id: &str) -> Result<Option<Meta>, ToolError> {
        if !valid_id(id) {
            return Err(invalid(format!("{id:?} is not an attachment id")));
        }
        match fs::read(self.meta_path(id)) {
            Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(internal),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(internal(e)),
        }
    }

    fn write_meta(&self, meta: &Meta) -> Result<(), ToolError> {
        let path = self.meta_path(&meta.id);
        let tmp = self.dir.join(format!(".{}.json.tmp", meta.id));
        let text = serde_json::to_vec(meta).map_err(internal)?;
        write_private(&tmp, &text, false).map_err(internal)?;
        fs::rename(&tmp, &path).map_err(internal)
    }

    fn remove(&self, id: &str) {
        let _ = fs::remove_file(self.data_path(id));
        let _ = fs::remove_file(self.meta_path(id));
    }

    pub fn upload(
        &self,
        input: &AgentUploadAttachmentInput,
        now: Timestamp,
    ) -> Result<AgentUploadAttachmentOutput, ToolError> {
        let bytes =
            b64::decode(&input.data_base64).ok_or_else(|| invalid("the data is not base64"))?;
        if bytes.len() as u64 > ATTACHMENT_MAX_CHUNK_BYTES {
            return Err(invalid(format!(
                "a piece is {} at most; send the file in pieces",
                mib(ATTACHMENT_MAX_CHUNK_BYTES)
            )));
        }
        let offset = input.offset.unwrap_or(0);
        let mut meta = match &input.upload_id {
            None => {
                if offset != 0 {
                    return Err(invalid("the first piece starts at 0"));
                }
                self.sweep(now);
                self.begin(input, now)?
            }
            Some(id) => {
                let meta = self
                    .read_meta(id)?
                    .ok_or_else(|| ToolError::not_found(format!("no upload {id}")))?;
                if meta.session.is_some() || meta.whole() {
                    return Err(ToolError::conflict(format!("upload {id} is complete")));
                }
                if meta.size_bytes != input.size_bytes {
                    return Err(invalid("the size changed during the upload"));
                }
                meta
            }
        };
        if offset != meta.received {
            return Err(ToolError::conflict(format!(
                "the next piece starts at byte {}",
                meta.received
            )));
        }
        if meta.received + bytes.len() as u64 > meta.size_bytes {
            self.remove(&meta.id);
            return Err(invalid(format!(
                "{} is larger than the {} bytes it said",
                meta.name, meta.size_bytes
            )));
        }
        write_private(&self.data_path(&meta.id), &bytes, offset > 0).map_err(internal)?;
        meta.received += bytes.len() as u64;
        if meta.received == meta.size_bytes
            && let Err(e) = self.finish(&mut meta)
        {
            self.remove(&meta.id);
            return Err(e);
        }
        self.write_meta(&meta)?;
        Ok(AgentUploadAttachmentOutput {
            upload_id: meta.id.clone(),
            received: meta.received,
            attachment: meta.whole().then(|| meta.attachment()),
        })
    }

    fn begin(&self, input: &AgentUploadAttachmentInput, now: Timestamp) -> Result<Meta, ToolError> {
        let name = clean_name(&input.name);
        let mime = input.mime_type.trim().to_ascii_lowercase();
        let (kind, max) = if mime.starts_with("image/") {
            if image_type(&mime).is_none() {
                return Err(invalid(format!(
                    "{name}: an image is PNG, JPEG, GIF or WebP"
                )));
            }
            (AttachmentKind::Image, ATTACHMENT_MAX_IMAGE_BYTES)
        } else {
            (AttachmentKind::File, ATTACHMENT_MAX_FILE_BYTES)
        };
        if input.size_bytes == 0 {
            return Err(invalid(format!("{name} is empty")));
        }
        if input.size_bytes > max {
            return Err(invalid(format!(
                "{name} is larger than {}, the most an {} can be",
                mib(max),
                if kind == AttachmentKind::Image {
                    "image"
                } else {
                    "attached file"
                }
            )));
        }
        let id = tessera_core::ids::unique("att_");
        let _ = fs::remove_file(self.data_path(&id));
        Ok(Meta {
            id,
            name,
            mime_type: mime,
            size_bytes: input.size_bytes,
            kind,
            received: 0,
            content: None,
            created_at: now.0,
            session: None,
        })
    }

    fn finish(&self, meta: &mut Meta) -> Result<(), ToolError> {
        let bytes = fs::read(self.data_path(&meta.id)).map_err(internal)?;
        match meta.kind {
            AttachmentKind::Image => {
                let sniffed = sniff_image(&bytes).ok_or_else(|| {
                    invalid(format!(
                        "{} is not a PNG, JPEG, GIF or WebP image",
                        meta.name
                    ))
                })?;
                meta.mime_type = sniffed.to_owned();
                meta.content = Some(Content::Image);
            }
            _ if bytes.starts_with(b"%PDF-") => {
                meta.mime_type = "application/pdf".into();
                meta.content = Some(Content::Pdf);
            }
            _ if meta.mime_type == "application/pdf" => {
                return Err(invalid(format!("{} is not a readable PDF", meta.name)));
            }
            _ if is_text(&bytes) => {
                if meta.mime_type.is_empty() || meta.mime_type == "application/octet-stream" {
                    meta.mime_type = "text/plain".into();
                }
                meta.content = Some(Content::Text);
            }
            _ => {
                return Err(invalid(format!(
                    "{}: the analyst reads images, PDFs and text files, not this kind of file",
                    meta.name
                )));
            }
        }
        Ok(())
    }

    pub fn get(&self, id: &str) -> Result<(Attachment, Vec<u8>), ToolError> {
        let meta = self
            .read_meta(id)?
            .filter(Meta::whole)
            .ok_or_else(|| ToolError::not_found(format!("no attachment {id}")))?;
        let bytes = fs::read(self.data_path(id)).map_err(internal)?;
        Ok((meta.attachment(), bytes))
    }

    pub fn discard(&self, id: &str) -> Result<bool, ToolError> {
        match self.read_meta(id)? {
            Some(meta) if meta.session.is_none() => {
                self.remove(id);
                Ok(true)
            }
            _ => Ok(false),
        }
    }

    pub fn resolve(
        &self,
        session: &SessionId,
        list: &[Attachment],
    ) -> Result<Vec<Resolved>, ToolError> {
        if list.len() > ATTACHMENT_MAX_PER_MESSAGE {
            return Err(invalid(format!(
                "a message carries {ATTACHMENT_MAX_PER_MESSAGE} attachments at most"
            )));
        }
        let mut out = Vec::new();
        let mut image_bytes = 0u64;
        let mut seen = std::collections::HashSet::new();
        for a in list {
            if !matches!(a.kind, AttachmentKind::Image | AttachmentKind::File) {
                continue;
            }
            let id =
                a.id.as_deref()
                    .ok_or_else(|| invalid(format!("{} has no upload id", a.label)))?;
            if !seen.insert(id.to_owned()) {
                continue;
            }
            let meta = self.read_meta(id)?.filter(Meta::whole).ok_or_else(|| {
                invalid(format!(
                    "{} is no longer uploaded; attach it again",
                    a.label
                ))
            })?;
            if meta
                .session
                .as_deref()
                .is_some_and(|s| s != session.as_str())
            {
                return Err(invalid(format!(
                    "{} belongs to another session; attach it again",
                    meta.name
                )));
            }
            if meta.kind == AttachmentKind::Image {
                image_bytes += meta.size_bytes;
                if image_bytes > ATTACHMENT_MAX_IMAGE_BYTES_PER_MESSAGE {
                    return Err(invalid(format!(
                        "a message's images are {} at most together",
                        mib(ATTACHMENT_MAX_IMAGE_BYTES_PER_MESSAGE)
                    )));
                }
            }
            let data = fs::read(self.data_path(id)).map_err(internal)?;
            let content = match meta.content {
                Some(Content::Image) => TurnContent::Image,
                Some(Content::Pdf) => TurnContent::Pdf,
                _ => TurnContent::Text,
            };
            out.push(Resolved {
                attachment: meta.attachment(),
                turn: TurnAttachment {
                    name: meta.name.clone(),
                    mime_type: meta.mime_type.clone(),
                    content,
                    data: Arc::from(data),
                },
            });
        }
        Ok(out)
    }

    pub fn claim(&self, session: &SessionId, ids: &[String]) {
        for id in ids {
            if let Ok(Some(mut meta)) = self.read_meta(id)
                && meta.session.is_none()
            {
                meta.session = Some(session.to_string());
                if let Err(e) = self.write_meta(&meta) {
                    tracing::warn!(error = %e.message, id, "attachment not claimed");
                }
            }
        }
    }

    pub fn release(&self, session: &SessionId, ids: &[String]) -> usize {
        ids.iter()
            .filter(|id| {
                self.read_meta(id)
                    .ok()
                    .flatten()
                    .is_some_and(|m| m.session.as_deref() == Some(session.as_str()))
            })
            .map(|id| self.remove(id))
            .count()
    }

    pub fn remove_session(&self, session: &SessionId) -> usize {
        self.each_meta()
            .into_iter()
            .filter(|m| m.session.as_deref() == Some(session.as_str()))
            .map(|m| self.remove(&m.id))
            .count()
    }

    pub fn sweep(&self, now: Timestamp) -> usize {
        let stale = |t: i64| now.0.saturating_sub(t) > PENDING_TTL_NS;
        let mut gone = 0;
        let mut known = std::collections::HashSet::new();
        for m in self.each_meta() {
            if m.session.is_none() && stale(m.created_at) {
                self.remove(&m.id);
                gone += 1;
            } else {
                known.insert(m.id);
            }
        }
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return gone;
        };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let id = name.strip_suffix(".data").unwrap_or_default();
            let orphan = (valid_id(id) && !known.contains(id)) || name.ends_with(".tmp");
            let old = e
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .is_none_or(|d| stale(d.as_nanos() as i64));
            if orphan && old && fs::remove_file(e.path()).is_ok() {
                gone += 1;
            }
        }
        gone
    }

    fn each_meta(&self) -> Vec<Meta> {
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return Vec::new();
        };
        entries
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                let id = name.strip_suffix(".json")?;
                valid_id(id).then(|| self.read_meta(id).ok().flatten())?
            })
            .collect()
    }
}

fn write_private(path: &Path, bytes: &[u8], append: bool) -> std::io::Result<()> {
    let mut opts = fs::OpenOptions::new();
    opts.create(true);
    if append {
        opts.append(true);
    } else {
        opts.write(true).truncate(true);
    }
    tessera_core::private::owner_only(&mut opts);
    let mut f = opts.open(path)?;
    f.write_all(bytes)?;
    f.sync_all()
}

fn fence_for(text: &str) -> String {
    let mut longest = 0;
    let mut run = 0;
    for c in text.chars() {
        if c == '`' {
            run += 1;
            longest = longest.max(run);
        } else {
            run = 0;
        }
    }
    "`".repeat((longest + 1).max(3))
}

fn language(name: &str) -> &str {
    let ext = name.rsplit_once('.').map(|(_, e)| e).unwrap_or_default();
    if ext.len() <= 10 && ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        ext
    } else {
        ""
    }
}

fn thousands(n: usize) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

pub fn prompt_text(text: &str, attachments: &[TurnAttachment]) -> String {
    let mut parts: Vec<String> = Vec::new();
    if !text.trim().is_empty() {
        parts.push(text.to_owned());
    }
    let mut budget = INLINE_TOTAL_MAX_CHARS;
    for a in attachments
        .iter()
        .filter(|a| a.content == TurnContent::Text)
    {
        let body = String::from_utf8_lossy(&a.data);
        let total = body.chars().count();
        let keep = total.min(INLINE_FILE_MAX_CHARS).min(budget);
        if keep == 0 {
            parts.push(format!(
                "[Attached file \"{}\" ({} characters) was not included: the message already holds {} characters of files]",
                a.name,
                thousands(total),
                thousands(INLINE_TOTAL_MAX_CHARS)
            ));
            continue;
        }
        budget -= keep;
        let shown: String = if keep < total {
            body.chars().take(keep).collect()
        } else {
            body.into_owned()
        };
        let head = if keep < total {
            format!(
                "Attached file \"{}\" (its first {} of {} characters; the rest was not sent):",
                a.name,
                thousands(keep),
                thousands(total)
            )
        } else {
            format!("Attached file \"{}\":", a.name)
        };
        let fence = fence_for(&shown);
        let nl = if shown.ends_with('\n') { "" } else { "\n" };
        parts.push(format!(
            "{head}\n{fence}{}\n{shown}{nl}{fence}",
            language(&a.name)
        ));
    }
    for a in attachments {
        match a.content {
            TurnContent::Image => parts.push(format!("[Attached image \"{}\"]", a.name)),
            TurnContent::Pdf => parts.push(format!("[Attached PDF \"{}\"]", a.name)),
            TurnContent::Text => {}
        }
    }
    parts.join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

    fn store() -> (tempfile::TempDir, AttachmentStore) {
        let dir = tempfile::tempdir().unwrap();
        let s = AttachmentStore::open(dir.path().join("attachments")).unwrap();
        (dir, s)
    }

    fn piece(name: &str, mime: &str, size: u64, data: &[u8]) -> AgentUploadAttachmentInput {
        AgentUploadAttachmentInput {
            name: name.into(),
            mime_type: mime.into(),
            size_bytes: size,
            data_base64: b64::encode(data),
            upload_id: None,
            offset: None,
        }
    }

    fn upload(s: &AttachmentStore, name: &str, mime: &str, data: &[u8]) -> Attachment {
        s.upload(&piece(name, mime, data.len() as u64, data), Timestamp(0))
            .unwrap()
            .attachment
            .unwrap()
    }

    #[test]
    fn an_image_uploads_whole_and_reads_back() {
        let (_d, s) = store();
        let a = upload(&s, "../shots/chart.png", "image/png", PNG);
        assert_eq!(a.kind, AttachmentKind::Image);
        assert_eq!(a.label, "chart.png", "a path is never kept");
        assert_eq!(a.mime_type.as_deref(), Some("image/png"));
        assert_eq!(a.size_bytes, Some(PNG.len() as u64));
        let id = a.id.clone().unwrap();
        assert!(valid_id(&id), "{id}");
        let (back, bytes) = s.get(&id).unwrap();
        assert_eq!(back, a);
        assert_eq!(bytes, PNG);
        assert!(
            tessera_core::private::is_private(&s.data_path(&id)),
            "the user's alone"
        );
    }

    #[test]
    fn a_large_file_uploads_in_pieces() {
        let (_d, s) = store();
        let text = "price,size\n".repeat(1000).into_bytes();
        let (a, b) = text.split_at(4000);
        let first = s
            .upload(
                &piece("fills.csv", "text/csv", text.len() as u64, a),
                Timestamp(0),
            )
            .unwrap();
        assert_eq!(first.received, 4000);
        assert!(first.attachment.is_none(), "not whole yet");
        let mut wrong = piece("fills.csv", "text/csv", text.len() as u64, b);
        wrong.upload_id = Some(first.upload_id.clone());
        wrong.offset = Some(10);
        assert_eq!(
            s.upload(&wrong, Timestamp(0)).unwrap_err().code,
            ToolError::conflict("").code
        );
        wrong.offset = Some(4000);
        let done = s.upload(&wrong, Timestamp(0)).unwrap();
        let att = done.attachment.unwrap();
        assert_eq!(att.kind, AttachmentKind::File);
        assert_eq!(att.mime_type.as_deref(), Some("text/csv"));
        assert_eq!(s.get(&done.upload_id).unwrap().1, text);
        assert!(s.upload(&wrong, Timestamp(0)).is_err());
    }

    #[test]
    fn limits_and_content_are_checked() {
        let (_d, s) = store();
        let big_image = piece("huge.png", "image/png", ATTACHMENT_MAX_IMAGE_BYTES + 1, PNG);
        let e = s.upload(&big_image, Timestamp(0)).unwrap_err();
        assert!(e.message.contains("10 MiB"), "{}", e.message);
        let big_file = piece(
            "huge.log",
            "text/plain",
            ATTACHMENT_MAX_FILE_BYTES + 1,
            b"x",
        );
        let e = s.upload(&big_file, Timestamp(0)).unwrap_err();
        assert!(e.message.contains("50 MiB"), "{}", e.message);
        assert!(
            s.upload(
                &piece("ok.log", "text/plain", ATTACHMENT_MAX_FILE_BYTES, b"x"),
                Timestamp(0)
            )
            .is_ok()
        );
        let e = s
            .upload(&piece("a.heic", "image/heic", 3, b"abc"), Timestamp(0))
            .unwrap_err();
        assert!(
            e.message.contains("PNG, JPEG, GIF or WebP"),
            "{}",
            e.message
        );
        let e = s
            .upload(&piece("e.txt", "text/plain", 0, b""), Timestamp(0))
            .unwrap_err();
        assert!(e.message.contains("empty"));
        let chunk = vec![b'a'; ATTACHMENT_MAX_CHUNK_BYTES as usize + 1];
        let e = s
            .upload(
                &piece("a.txt", "text/plain", chunk.len() as u64, &chunk),
                Timestamp(0),
            )
            .unwrap_err();
        assert!(e.message.contains("in pieces"), "{}", e.message);
        let e = s
            .upload(&piece("fake.png", "image/png", 4, b"GIF8"), Timestamp(0))
            .unwrap_err();
        assert!(e.message.contains("not a PNG"), "{}", e.message);
        let gif = upload(&s, "a.png", "image/png", b"GIF89a\x01\x00");
        assert_eq!(gif.mime_type.as_deref(), Some("image/gif"));
        let e = s
            .upload(
                &piece("a.zip", "application/zip", 4, b"PK\x03\x04"),
                Timestamp(0),
            )
            .unwrap_err();
        assert!(e.message.contains("images, PDFs and text"), "{}", e.message);
        let pdf = upload(&s, "report.pdf", "", b"%PDF-1.4\n...");
        assert_eq!(pdf.mime_type.as_deref(), Some("application/pdf"));
        let md = upload(&s, "notes.md", "", "# Plan\n".as_bytes());
        assert_eq!(md.mime_type.as_deref(), Some("text/plain"));
        let files: Vec<_> = fs::read_dir(s.dir()).unwrap().flatten().collect();
        assert_eq!(files.len(), 3 * 2 + 2, "{files:?}");
    }

    #[test]
    fn a_message_is_held_to_its_limits() {
        let (_d, s) = store();
        let sid = SessionId::new("S1");
        let a = upload(&s, "a.png", "image/png", PNG);
        let many = vec![a.clone(); ATTACHMENT_MAX_PER_MESSAGE + 1];
        assert!(s.resolve(&sid, &many).unwrap_err().message.contains("100"));
        let r = s.resolve(&sid, &[a.clone(), a.clone()]).unwrap();
        assert_eq!(r.len(), 1, "the same upload once");
        assert_eq!(r[0].turn.content, TurnContent::Image);
        assert_eq!(&*r[0].turn.data, PNG);
        let mut bad = a.clone();
        bad.id = Some("../../etc/passwd".into());
        assert!(s.resolve(&sid, &[bad]).is_err());
        let mut gone = a.clone();
        gone.id = Some(format!("att_{}", "0".repeat(32)));
        assert!(
            s.resolve(&sid, &[gone])
                .unwrap_err()
                .message
                .contains("attach it again")
        );
        s.claim(&sid, &[a.id.clone().unwrap()]);
        assert!(s.resolve(&sid, std::slice::from_ref(&a)).is_ok());
        assert!(
            s.resolve(&SessionId::new("S2"), std::slice::from_ref(&a))
                .is_err()
        );
        assert!(
            !s.discard(a.id.as_deref().unwrap()).unwrap(),
            "a sent one stays"
        );
        assert_eq!(s.remove_session(&sid), 1);
        assert!(s.get(a.id.as_deref().unwrap()).is_err());
    }

    #[test]
    fn a_message_s_images_weigh_80_mib_at_most() {
        let (_d, s) = store();
        let mut list = Vec::new();
        for i in 0..9 {
            let a = upload(&s, &format!("{i}.png"), "image/png", PNG);
            let id = a.id.clone().unwrap();
            let mut meta = s.read_meta(&id).unwrap().unwrap();
            meta.size_bytes = ATTACHMENT_MAX_IMAGE_BYTES;
            meta.received = meta.size_bytes;
            s.write_meta(&meta).unwrap();
            list.push(a);
        }
        let sid = SessionId::new("S1");
        assert!(s.resolve(&sid, &list[..8]).is_ok());
        let e = s.resolve(&sid, &list).unwrap_err();
        assert!(e.message.contains("80 MiB"), "{}", e.message);
    }

    #[test]
    fn unsent_uploads_are_swept_after_a_day() {
        let (_d, s) = store();
        let day = PENDING_TTL_NS;
        let old = s
            .upload(
                &piece("old.png", "image/png", PNG.len() as u64, PNG),
                Timestamp(0),
            )
            .unwrap()
            .upload_id;
        let sent = s
            .upload(
                &piece("sent.png", "image/png", PNG.len() as u64, PNG),
                Timestamp(0),
            )
            .unwrap()
            .upload_id;
        s.claim(&SessionId::new("S1"), std::slice::from_ref(&sent));
        let fresh = s
            .upload(
                &piece("new.png", "image/png", PNG.len() as u64, PNG),
                Timestamp(day),
            )
            .unwrap()
            .upload_id;
        assert_eq!(s.sweep(Timestamp(day - 1)), 0, "not a day yet");
        assert_eq!(s.sweep(Timestamp(day + 1)), 1);
        assert!(s.get(&old).is_err());
        assert!(s.get(&sent).is_ok(), "a sent one is never swept");
        assert!(s.get(&fresh).is_ok());
        assert!(s.discard(&fresh).unwrap());
        assert!(s.get(&fresh).is_err());
    }

    #[test]
    fn a_session_releases_only_the_uploads_it_claimed() {
        let (_d, s) = store();
        let png = |name: &str| {
            s.upload(
                &piece(name, "image/png", PNG.len() as u64, PNG),
                Timestamp(0),
            )
            .unwrap()
            .upload_id
        };
        let (mine, theirs, loose) = (png("a.png"), png("b.png"), png("c.png"));
        s.claim(&SessionId::new("S1"), std::slice::from_ref(&mine));
        s.claim(&SessionId::new("S2"), std::slice::from_ref(&theirs));
        let all = [mine.clone(), theirs.clone(), loose.clone()];
        assert_eq!(s.release(&SessionId::new("S1"), &all), 1);
        assert!(s.get(&mine).is_err());
        assert!(s.get(&theirs).is_ok(), "another session's stays");
        assert!(
            s.get(&loose).is_ok(),
            "an unsent one stays for its own message"
        );
        assert_eq!(s.release(&SessionId::new("S1"), &all), 0);
    }

    fn text_file(name: &str, body: &str) -> TurnAttachment {
        TurnAttachment {
            name: name.into(),
            mime_type: "text/plain".into(),
            content: TurnContent::Text,
            data: Arc::from(body.as_bytes()),
        }
    }

    #[test]
    fn text_files_are_inlined_after_the_words_and_cut_saying_so() {
        let image = TurnAttachment {
            name: "chart.png".into(),
            mime_type: "image/png".into(),
            content: TurnContent::Image,
            data: Arc::from(PNG),
        };
        let t = prompt_text(
            "What does this say?",
            &[text_file("notes.md", "a ``` fence\n"), image],
        );
        assert_eq!(
            t,
            "What does this say?\n\nAttached file \"notes.md\":\n````md\na ``` fence\n````\n\n[Attached image \"chart.png\"]"
        );
        let long = "x".repeat(INLINE_FILE_MAX_CHARS + 5);
        let t = prompt_text("", &[text_file("big.log", &long)]);
        assert!(t.starts_with("Attached file \"big.log\" (its first 100,000 of 100,005 characters; the rest was not sent):\n```log\n"), "{}", &t[..120]);
        let files: Vec<_> = (0..3)
            .map(|i| text_file(&format!("{i}.txt"), &long))
            .collect();
        let t = prompt_text("q", &files);
        assert!(t.contains("[Attached file \"2.txt\" (100,005 characters) was not included"));
    }
}
