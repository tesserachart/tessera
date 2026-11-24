use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use tessera_core::Timestamp;
use tessera_core::hash::sha256_hex;

use crate::Store;
use crate::error::{Result, StoreError, io_err};

const ZSTD_LEVEL: i32 = 9;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobRef {
    pub sha256: String,
    pub size: u64,
    pub stored_size: u64,
    pub media_type: String,
    pub source: Option<String>,
    pub created_at: Timestamp,
}

#[derive(Clone, Debug)]
pub struct BlobStore {
    dir: PathBuf,
    store: Store,
}

fn check_digest(sha: &str) -> Result<()> {
    if sha.len() == 64
        && sha
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    {
        Ok(())
    } else {
        Err(StoreError::Invalid(format!("not a sha256 digest: {sha:?}")))
    }
}

impl BlobStore {
    pub fn open(dir: impl AsRef<Path>, store: Store) -> Result<Self> {
        let dir = dir.as_ref().to_path_buf();
        fs::create_dir_all(&dir).map_err(io_err(&dir))?;
        Ok(Self { dir, store })
    }

    pub fn path_for(&self, sha: &str) -> Result<PathBuf> {
        check_digest(sha)?;
        Ok(self
            .dir
            .join(&sha[0..2])
            .join(&sha[2..4])
            .join(format!("{sha}.zst")))
    }

    pub fn put(&self, bytes: &[u8], media_type: &str, source: Option<&str>) -> Result<BlobRef> {
        let sha = sha256_hex(bytes);
        if let Some(existing) = self.manifest(&sha)?
            && self.path_for(&sha)?.exists()
        {
            return Ok(existing);
        }
        let path = self.path_for(&sha)?;
        let parent = path.parent().unwrap_or(&self.dir).to_path_buf();
        fs::create_dir_all(&parent).map_err(io_err(&parent))?;
        let compressed = zstd::encode_all(bytes, ZSTD_LEVEL).map_err(io_err(&path))?;
        let tmp = parent.join(format!(".{sha}.{}.tmp", std::process::id()));
        {
            let mut f = fs::File::create(&tmp).map_err(io_err(&tmp))?;
            f.write_all(&compressed).map_err(io_err(&tmp))?;
            f.sync_all().map_err(io_err(&tmp))?;
        }
        fs::rename(&tmp, &path).map_err(io_err(&path))?;
        let blob = BlobRef {
            sha256: sha,
            size: bytes.len() as u64,
            stored_size: compressed.len() as u64,
            media_type: media_type.to_owned(),
            source: source.map(str::to_owned),
            created_at: Timestamp::now(),
        };
        self.store.conn()?.execute(
            "INSERT OR IGNORE INTO blobs (sha256, size, stored_size, media_type, source, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                blob.sha256,
                blob.size as i64,
                blob.stored_size as i64,
                blob.media_type,
                blob.source,
                blob.created_at.0
            ],
        )?;
        Ok(blob)
    }

    pub fn manifest(&self, sha: &str) -> Result<Option<BlobRef>> {
        check_digest(sha)?;
        Ok(self
            .store
            .conn()?
            .query_row(
                "SELECT sha256, size, stored_size, media_type, source, created_at
                 FROM blobs WHERE sha256 = ?1",
                params![sha],
                |r| {
                    Ok(BlobRef {
                        sha256: r.get(0)?,
                        size: r.get::<_, i64>(1)? as u64,
                        stored_size: r.get::<_, i64>(2)? as u64,
                        media_type: r.get(3)?,
                        source: r.get(4)?,
                        created_at: Timestamp(r.get(5)?),
                    })
                },
            )
            .optional()?)
    }

    pub fn contains(&self, sha: &str) -> bool {
        self.path_for(sha).map(|p| p.exists()).unwrap_or(false)
    }

    pub fn get(&self, sha: &str) -> Result<Vec<u8>> {
        let path = self.path_for(sha)?;
        if !path.exists() {
            return Err(StoreError::NotFound(format!("blob {sha}")));
        }
        let compressed = fs::read(&path).map_err(io_err(&path))?;
        let bytes =
            zstd::decode_all(compressed.as_slice()).map_err(|e| StoreError::CorruptBlob {
                sha256: sha.to_owned(),
                reason: format!("zstd: {e}"),
            })?;
        let actual = sha256_hex(&bytes);
        if actual != sha {
            return Err(StoreError::CorruptBlob {
                sha256: sha.to_owned(),
                reason: format!("digest mismatch: {actual}"),
            });
        }
        Ok(bytes)
    }

    pub fn verify(&self, sha: &str) -> Result<()> {
        self.get(sha).map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (tempfile::TempDir, BlobStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open_in_dir(dir.path()).unwrap();
        let blobs = BlobStore::open(dir.path().join("blobs"), store).unwrap();
        (dir, blobs)
    }

    #[test]
    fn put_get_dedupe_and_manifest() {
        let (_d, b) = setup();
        let payload = br#"{"ticker":"QQQ","major_pos_vol":490.0,"zero_gamma":484.9}"#.repeat(50);
        let r = b
            .put(&payload, "application/json", Some("acme:/v2/classic/QQQ"))
            .unwrap();
        assert_eq!(r.size, payload.len() as u64);
        assert!(r.stored_size < r.size, "compressed");
        assert_eq!(b.get(&r.sha256).unwrap(), payload);
        let again = b.put(&payload, "application/json", None).unwrap();
        assert_eq!(again, r, "stored once");
        assert_eq!(
            b.manifest(&r.sha256).unwrap().unwrap().source.as_deref(),
            Some("acme:/v2/classic/QQQ")
        );
        let p = b.path_for(&r.sha256).unwrap();
        assert!(p.ends_with(format!(
            "{}/{}/{}.zst",
            &r.sha256[0..2],
            &r.sha256[2..4],
            r.sha256
        )));
        assert!(b.contains(&r.sha256));
    }

    #[test]
    fn corruption_is_detected() {
        let (_d, b) = setup();
        let r = b
            .put(b"frame-bytes", "application/octet-stream", None)
            .unwrap();
        let path = b.path_for(&r.sha256).unwrap();
        let other = zstd::encode_all(&b"tampered"[..], 3).unwrap();
        fs::write(&path, other).unwrap();
        assert!(matches!(
            b.get(&r.sha256),
            Err(StoreError::CorruptBlob { .. })
        ));
        fs::write(&path, b"not zstd").unwrap();
        assert!(matches!(
            b.verify(&r.sha256),
            Err(StoreError::CorruptBlob { .. })
        ));
    }

    #[test]
    fn digests_are_validated() {
        let (_d, b) = setup();
        assert!(matches!(
            b.get("../../etc/passwd"),
            Err(StoreError::Invalid(_))
        ));
        assert!(matches!(
            b.get(&"A".repeat(64)),
            Err(StoreError::Invalid(_))
        ));
        assert!(matches!(
            b.get(&"a".repeat(64)),
            Err(StoreError::NotFound(_))
        ));
        assert!(!b.contains("zz"));
    }
}
