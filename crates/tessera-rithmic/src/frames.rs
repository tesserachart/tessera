use std::io::{Read, Write};

use rithmic_rs::prost::Message;
use rithmic_rs::rti::messages::RithmicMessage;
use rithmic_rs::rti::{
    BestBidOffer, DepthByOrder, DepthByOrderEndEvent, LastTrade, MessageType,
    ResponseDepthByOrderSnapshot, ResponseFrontMonthContract, ResponseReferenceData,
    ResponseTimeBarReplay, TradeStatistics,
};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FrameError {
    #[error("truncated frame at byte {0}")]
    Truncated(usize),
    #[error("frame {index} (template {template}) does not decode: {reason}")]
    Decode {
        index: usize,
        template: i32,
        reason: String,
    },
    #[error("template {0} is not a market-data template")]
    NotRecordable(i32),
    #[error("cannot read the recording: {0}")]
    Io(String),
}

pub fn encode_message(msg: &RithmicMessage) -> Option<Vec<u8>> {
    Some(match msg {
        RithmicMessage::ResponseReferenceData(m) => m.encode_to_vec(),
        RithmicMessage::ResponseFrontMonthContract(m) => m.encode_to_vec(),
        RithmicMessage::ResponseDepthByOrderSnapshot(m) => m.encode_to_vec(),
        RithmicMessage::LastTrade(m) => m.encode_to_vec(),
        RithmicMessage::BestBidOffer(m) => m.encode_to_vec(),
        RithmicMessage::TradeStatistics(m) => m.encode_to_vec(),
        RithmicMessage::DepthByOrder(m) => m.encode_to_vec(),
        RithmicMessage::DepthByOrderEndEvent(m) => m.encode_to_vec(),
        RithmicMessage::ResponseTimeBarReplay(m) => m.encode_to_vec(),
        _ => return None,
    })
}

fn decode_indexed(index: usize, body: &[u8]) -> Result<RithmicMessage, FrameError> {
    let err = |template: i32, e: rithmic_rs::prost::DecodeError| FrameError::Decode {
        index,
        template,
        reason: e.to_string(),
    };
    let template = MessageType::decode(body)
        .map_err(|e| err(0, e))?
        .template_id;
    let m = match template {
        15 => RithmicMessage::ResponseReferenceData(
            ResponseReferenceData::decode(body).map_err(|e| err(template, e))?,
        ),
        114 => RithmicMessage::ResponseFrontMonthContract(
            ResponseFrontMonthContract::decode(body).map_err(|e| err(template, e))?,
        ),
        116 => RithmicMessage::ResponseDepthByOrderSnapshot(
            ResponseDepthByOrderSnapshot::decode(body).map_err(|e| err(template, e))?,
        ),
        150 => RithmicMessage::LastTrade(LastTrade::decode(body).map_err(|e| err(template, e))?),
        151 => {
            RithmicMessage::BestBidOffer(BestBidOffer::decode(body).map_err(|e| err(template, e))?)
        }
        152 => RithmicMessage::TradeStatistics(
            TradeStatistics::decode(body).map_err(|e| err(template, e))?,
        ),
        160 => {
            RithmicMessage::DepthByOrder(DepthByOrder::decode(body).map_err(|e| err(template, e))?)
        }
        161 => RithmicMessage::DepthByOrderEndEvent(
            DepthByOrderEndEvent::decode(body).map_err(|e| err(template, e))?,
        ),
        203 => RithmicMessage::ResponseTimeBarReplay(
            ResponseTimeBarReplay::decode(body).map_err(|e| err(template, e))?,
        ),
        other => return Err(FrameError::NotRecordable(other)),
    };
    Ok(m)
}

#[derive(Debug)]
pub struct FrameWriter<W: Write> {
    out: W,
    frames: usize,
}

impl<W: Write> FrameWriter<W> {
    pub fn new(out: W) -> Self {
        Self { out, frames: 0 }
    }

    pub fn write(&mut self, msg: &RithmicMessage) -> std::io::Result<bool> {
        let Some(body) = encode_message(msg) else {
            return Ok(false);
        };
        let len = u32::try_from(body.len()).map_err(std::io::Error::other)?;
        self.out.write_all(&len.to_be_bytes())?;
        self.out.write_all(&body)?;
        self.frames += 1;
        Ok(true)
    }

    pub fn frames(&self) -> usize {
        self.frames
    }

    pub fn into_inner(self) -> W {
        self.out
    }
}

pub fn read_frames(bytes: &[u8]) -> Result<Vec<RithmicMessage>, FrameError> {
    let mut out = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        let head = bytes.get(at..at + 4).ok_or(FrameError::Truncated(at))?;
        let len = u32::from_be_bytes([head[0], head[1], head[2], head[3]]) as usize;
        let body = bytes
            .get(at + 4..at + 4 + len)
            .ok_or(FrameError::Truncated(at))?;
        out.push(decode_indexed(out.len(), body)?);
        at += 4 + len;
    }
    Ok(out)
}

pub fn compress(frames: &[u8]) -> std::io::Result<Vec<u8>> {
    zstd::encode_all(frames, 19)
}

pub fn read_recording(compressed: &[u8]) -> Result<Vec<RithmicMessage>, FrameError> {
    let mut raw = Vec::new();
    zstd::Decoder::new(compressed)
        .and_then(|mut d| d.read_to_end(&mut raw))
        .map_err(|e| FrameError::Io(e.to_string()))?;
    read_frames(&raw)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rithmic_rs::rti::ResponseLogin;

    #[test]
    fn round_trips_market_data_and_refuses_the_rest() {
        let mut trade = LastTrade::default();
        trade.template_id = 150;
        trade.trade_price = Some(6712.25);
        trade.trade_size = Some(3);
        let mut w = FrameWriter::new(Vec::new());
        assert!(w.write(&RithmicMessage::LastTrade(trade.clone())).unwrap());
        let mut login = ResponseLogin::default();
        login.template_id = 11;
        assert!(!w.write(&RithmicMessage::ResponseLogin(login)).unwrap());
        assert_eq!(w.frames(), 1);
        let bytes = w.into_inner();
        let back = read_recording(&compress(&bytes).unwrap()).unwrap();
        assert_eq!(back, vec![RithmicMessage::LastTrade(trade)]);
        assert_eq!(read_frames(&bytes[..3]), Err(FrameError::Truncated(0)));
    }
}
