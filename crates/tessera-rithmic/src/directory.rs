//! R|Protocol answers templates 16 and 20 without a login.
//! The gateway closes the WebSocket once it has answered either one.

use std::fmt;
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use rithmic_rs::prost::Message as _;
use rithmic_rs::rti::{
    MessageType, RequestRithmicSystemGatewayInfo, RequestRithmicSystemInfo,
    ResponseRithmicSystemGatewayInfo, ResponseRithmicSystemInfo,
};
use tokio_tungstenite_rithmic::tungstenite::Message;

use crate::credentials::{gateway_is_safe, redact_gateway};

const SYSTEM_INFO: (i32, i32) = (16, 17);
const GATEWAY_INFO: (i32, i32) = (20, 21);

#[derive(Clone, PartialEq, Eq)]
pub struct Gateway {
    pub name: String,
    pub uri: String,
}

impl fmt::Debug for Gateway {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Gateway")
            .field("name", &self.name)
            .field("uri", &"[redacted]")
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DirectoryError {
    #[error("the address is not a wss:// URL")]
    Unsafe,
    #[error("cannot reach Rithmic: {0}")]
    Unreachable(String),
    #[error("Rithmic refused the request: {0}")]
    Refused(String),
    #[error("Rithmic's answer cannot be read: {0}")]
    Unreadable(String),
}

pub async fn systems(url: &str, timeout: Duration) -> Result<Vec<String>, DirectoryError> {
    let mut request = RequestRithmicSystemInfo::default();
    request.template_id = SYSTEM_INFO.0;
    let body = ask(url, &request.encode_to_vec(), SYSTEM_INFO.1, timeout).await?;
    let answer = ResponseRithmicSystemInfo::decode(body.as_slice())
        .map_err(|e| DirectoryError::Unreadable(e.to_string()))?;
    accepted(&answer.rp_code)?;
    Ok(answer
        .system_name
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect())
}

pub async fn gateways(
    url: &str,
    system: &str,
    timeout: Duration,
) -> Result<Vec<Gateway>, DirectoryError> {
    let mut request = RequestRithmicSystemGatewayInfo::default();
    request.template_id = GATEWAY_INFO.0;
    request.system_name = Some(system.to_owned());
    let body = ask(url, &request.encode_to_vec(), GATEWAY_INFO.1, timeout).await?;
    let answer = ResponseRithmicSystemGatewayInfo::decode(body.as_slice())
        .map_err(|e| DirectoryError::Unreadable(e.to_string()))?;
    accepted(&answer.rp_code)?;
    Ok(answer
        .gateway_name
        .into_iter()
        .zip(answer.gateway_uri)
        .filter(|(name, uri)| !name.is_empty() && gateway_is_safe(uri))
        .map(|(name, uri)| Gateway { name, uri })
        .collect())
}

/// R|Protocol's `rp_code` is success when empty or led by `"0"`; else a code, then words.
fn accepted(rp_code: &[String]) -> Result<(), DirectoryError> {
    match rp_code.split_first() {
        None => Ok(()),
        Some((code, _)) if code == "0" => Ok(()),
        Some((code, rest)) => {
            let words = rest.join(" ");
            Err(DirectoryError::Refused(if words.trim().is_empty() {
                format!("code {code}")
            } else {
                format!("{} (code {code})", words.trim())
            }))
        }
    }
}

async fn ask(
    url: &str,
    request: &[u8],
    answer: i32,
    timeout: Duration,
) -> Result<Vec<u8>, DirectoryError> {
    if !gateway_is_safe(url) {
        return Err(DirectoryError::Unsafe);
    }
    let unreachable =
        |e: &dyn fmt::Display| DirectoryError::Unreachable(redact_gateway(url, &e.to_string()));
    let mut frame = (request.len() as u32).to_be_bytes().to_vec();
    frame.extend_from_slice(request);
    let exchange = async {
        let (mut ws, _) = tokio_tungstenite_rithmic::connect_async(url)
            .await
            .map_err(|e| unreachable(&e))?;
        ws.send(Message::Binary(frame.into()))
            .await
            .map_err(|e| unreachable(&e))?;
        while let Some(msg) = ws.next().await {
            let bytes = match msg.map_err(|e| unreachable(&e))? {
                Message::Binary(bytes) => bytes,
                Message::Close(_) => break,
                _ => continue,
            };
            let Some(body) = frame_body(&bytes) else {
                continue;
            };
            if MessageType::decode(body).is_ok_and(|m| m.template_id == answer) {
                let body = body.to_vec();
                let _ = ws.close(None).await;
                return Ok(body);
            }
        }
        Err(DirectoryError::Unreachable(
            "the gateway closed the connection before it answered".into(),
        ))
    };
    tokio::time::timeout(timeout, exchange)
        .await
        .map_err(|_| DirectoryError::Unreachable("no answer in time".into()))?
}

fn frame_body(frame: &[u8]) -> Option<&[u8]> {
    let (len, rest) = frame.split_first_chunk::<4>()?;
    rest.get(..u32::from_be_bytes(*len) as usize)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rithmic_rs::rti::ResponseHeartbeat;
    use tokio::net::TcpListener;

    #[derive(Clone, Copy)]
    enum Mode {
        Answer,
        Refuse,
        Close,
        Silent,
    }

    fn frame(m: &impl rithmic_rs::prost::Message) -> Message {
        let body = m.encode_to_vec();
        let mut out = (body.len() as u32).to_be_bytes().to_vec();
        out.extend(body);
        Message::Binary(out.into())
    }

    async fn gateway(mode: Mode) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let Ok(mut ws) = tokio_tungstenite_rithmic::accept_async(tcp).await else {
                        return;
                    };
                    let Some(Ok(Message::Binary(bytes))) = ws.next().await else {
                        return;
                    };
                    let request = RequestRithmicSystemGatewayInfo::decode(&bytes[4..]).unwrap();
                    let rp_code: Vec<String> = match mode {
                        Mode::Answer => vec!["0".into()],
                        Mode::Refuse => vec!["5".into(), "permission denied".into()],
                        Mode::Close => {
                            let _ = ws.close(None).await;
                            return;
                        }
                        Mode::Silent => {
                            tokio::time::sleep(Duration::from_secs(30)).await;
                            return;
                        }
                    };
                    let _ = ws.send(Message::Text("hello".into())).await;
                    let mut other = ResponseHeartbeat::default();
                    other.template_id = 19;
                    let _ = ws.send(frame(&other)).await;
                    let reply = match request.template_id {
                        16 => {
                            let mut r = ResponseRithmicSystemInfo::default();
                            r.template_id = 17;
                            r.rp_code = rp_code;
                            r.system_name =
                                vec!["Rithmic Test".into(), "Apex".into(), "Bulenox".into()];
                            frame(&r)
                        }
                        20 => {
                            let mut r = ResponseRithmicSystemGatewayInfo::default();
                            r.template_id = 21;
                            r.rp_code = rp_code;
                            r.system_name = request.system_name.clone();
                            r.gateway_name =
                                vec!["Chicago Area".into(), "Europe".into(), "Plain".into()];
                            r.gateway_uri = vec![
                                "wss://chicago.invalid:443".into(),
                                "wss://europe.invalid:443".into(),
                                "ws://plain.invalid:80".into(),
                            ];
                            frame(&r)
                        }
                        _ => return,
                    };
                    let _ = ws.send(reply).await;
                    let _ = ws.close(None).await;
                });
            }
        });
        url
    }

    const WAIT: Duration = Duration::from_secs(5);

    #[tokio::test]
    async fn lists_systems_and_gateways_in_rithmics_order() {
        let url = gateway(Mode::Answer).await;
        assert_eq!(
            systems(&url, WAIT).await.unwrap(),
            ["Rithmic Test", "Apex", "Bulenox"]
        );
        let found = gateways(&url, "Apex", WAIT).await.unwrap();
        assert_eq!(
            found,
            [
                Gateway {
                    name: "Chicago Area".into(),
                    uri: "wss://chicago.invalid:443".into()
                },
                Gateway {
                    name: "Europe".into(),
                    uri: "wss://europe.invalid:443".into()
                },
            ]
        );
        let shown = format!("{found:?}");
        assert!(shown.contains("Chicago Area") && !shown.contains("chicago.invalid"));
    }

    #[tokio::test]
    async fn a_refusal_a_closed_connection_and_silence_are_said_without_the_address() {
        let url = gateway(Mode::Refuse).await;
        assert_eq!(
            systems(&url, WAIT).await,
            Err(DirectoryError::Refused("permission denied (code 5)".into()))
        );
        assert_eq!(
            gateways(&url, "Apex", WAIT).await,
            Err(DirectoryError::Refused("permission denied (code 5)".into()))
        );

        let url = gateway(Mode::Close).await;
        let e = systems(&url, WAIT).await.unwrap_err();
        assert!(matches!(e, DirectoryError::Unreachable(_)), "{e}");

        let url = gateway(Mode::Silent).await;
        let e = gateways(&url, "Apex", Duration::from_millis(300))
            .await
            .unwrap_err();
        assert_eq!(e, DirectoryError::Unreachable("no answer in time".into()));

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        drop(listener);
        let e = systems(&url, WAIT).await.unwrap_err();
        assert!(matches!(e, DirectoryError::Unreachable(_)), "{e}");
        assert!(!e.to_string().contains("127.0.0.1"), "{e}");
    }

    #[tokio::test]
    async fn only_an_address_a_login_could_use_is_asked() {
        for url in ["ws://directory.invalid:80", "https://directory.invalid"] {
            assert_eq!(systems(url, WAIT).await, Err(DirectoryError::Unsafe));
        }
    }

    #[test]
    fn transport_errors_lose_the_address() {
        let url = "wss://directory.invalid:443/x";
        assert_eq!(
            redact_gateway(
                url,
                "failed wss://directory.invalid:443/x (directory.invalid)"
            ),
            "failed [gateway] ([gateway])"
        );
    }
}
