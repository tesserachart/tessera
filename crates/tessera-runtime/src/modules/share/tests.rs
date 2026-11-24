use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use super::*;

const PNG_BASE64: &str = "iVBORw0KGgoAAAANSUhEUg==";

#[derive(Default)]
struct FakeCloud {
    signed_out: AtomicBool,
    sent: Mutex<Vec<NewShare>>,
    links: Mutex<Vec<SharedLink>>,
    down: AtomicBool,
}

#[async_trait]
impl ShareCloud for FakeCloud {
    fn available(&self) -> bool {
        !self.signed_out.load(Ordering::SeqCst)
    }

    async fn create(&self, share: &NewShare) -> Result<SharedLink, CloudError> {
        if self.down.load(Ordering::SeqCst) {
            return Err(CloudError::Unreachable("connection refused".into()));
        }
        self.sent.lock().unwrap().push(share.clone());
        let mut links = self.links.lock().unwrap();
        let id = format!("Ab3dE6gH9jK{}", links.len());
        let link = SharedLink {
            url: format!("https://account.example.test/s/{id}"),
            id,
            kind: share.kind.clone(),
            title: share.title.clone(),
            created_at: "2026-11-23T10:00:00.000Z".into(),
        };
        links.insert(0, link.clone());
        Ok(link)
    }

    async fn list(&self) -> Result<Vec<SharedLink>, CloudError> {
        Ok(self.links.lock().unwrap().clone())
    }

    async fn delete(&self, id: &str) -> Result<(), CloudError> {
        let mut links = self.links.lock().unwrap();
        let before = links.len();
        links.retain(|l| l.id != id);
        if links.len() == before {
            return Err(CloudError::Server {
                status: 404,
                code: Some("not_found".into()),
            });
        }
        Ok(())
    }
}

fn service() -> (Arc<ShareService>, Arc<FakeCloud>) {
    let cloud = Arc::new(FakeCloud::default());
    (
        ShareService::new(Arc::clone(&cloud) as Arc<dyn ShareCloud>),
        cloud,
    )
}

fn chart(data: &str, mime_type: &str) -> ShareChartInput {
    ShareChartInput {
        image: ShareImageInput {
            mime_type: mime_type.into(),
            data: data.into(),
            width: 1600,
            height: 900,
        },
        instrument: Some("NQZ6.CME".into()),
        timeframe: Some("5m".into()),
    }
}

#[tokio::test]
async fn a_chart_is_shared_listed_and_deleted() {
    let (s, cloud) = service();
    let link = s.chart(&chart(PNG_BASE64, "image/png")).await.unwrap();
    assert_eq!(link.title, "NQZ6.CME · 5m");
    assert_eq!(
        link.url,
        format!("https://account.example.test/s/{}", link.id)
    );
    let sent = cloud.sent.lock().unwrap()[0].clone();
    assert_eq!(
        (sent.kind.as_str(), sent.width, sent.height),
        ("chart", 1600, 900)
    );

    let listed = s.list().await.unwrap();
    assert!(listed.available);
    assert_eq!(listed.shares, vec![link.clone()]);

    s.delete(&ShareDeleteInput {
        id: link.id.clone(),
    })
    .await
    .unwrap();
    assert!(s.list().await.unwrap().shares.is_empty());
    let again = s
        .delete(&ShareDeleteInput { id: link.id })
        .await
        .unwrap_err();
    assert_eq!(again.message, "That link is already gone.");
}

#[tokio::test]
async fn signed_out_nothing_is_sent_and_the_list_says_sharing_is_off() {
    let (s, cloud) = service();
    cloud.signed_out.store(true, Ordering::SeqCst);
    let e = s.chart(&chart(PNG_BASE64, "image/png")).await.unwrap_err();
    assert_eq!(e.message, "Sign in to Tessera to share.");
    assert!(cloud.sent.lock().unwrap().is_empty());
    let listed = s.list().await.unwrap();
    assert!(!listed.available && listed.shares.is_empty());
}

#[tokio::test]
async fn only_a_real_picture_goes() {
    let (s, cloud) = service();
    for (data, mime_type) in [
        (PNG_BASE64, "image/svg+xml"),
        ("PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+", "image/png"),
        (PNG_BASE64, "image/jpeg"),
        ("not base64!", "image/png"),
    ] {
        assert!(
            s.chart(&chart(data, mime_type)).await.is_err(),
            "{mime_type} {data}"
        );
    }
    assert!(cloud.sent.lock().unwrap().is_empty());
}

#[tokio::test]
async fn an_unreachable_cloud_says_so_in_plain_words() {
    let (s, cloud) = service();
    cloud.down.store(true, Ordering::SeqCst);
    let e = s.chart(&chart(PNG_BASE64, "image/png")).await.unwrap_err();
    assert_eq!(
        e.message,
        "Tessera Cloud can’t be reached. Try again in a moment."
    );
}

#[test]
fn the_title_names_the_chart_and_nothing_private() {
    assert_eq!(chart_title(Some("ESZ6.CME"), Some("1m")), "ESZ6.CME · 1m");
    assert_eq!(chart_title(None, None), "Chart");
    assert_eq!(chart_title(Some("  "), Some("5m")), "5m");
    assert_eq!(
        chart_title(Some("APEX-1234567-01"), None),
        "[account]",
        "an account id never reaches a public title"
    );
}

#[tokio::test]
async fn a_delete_takes_only_a_share_id() {
    let (s, _cloud) = service();
    for id in ["", "../admin", "a/b", "id with space"] {
        assert!(
            s.delete(&ShareDeleteInput { id: id.into() }).await.is_err(),
            "{id:?}"
        );
    }
}
