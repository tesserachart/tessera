use std::fmt;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::de::{self, SeqAccess, Visitor};
use serde::ser::SerializeTuple;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use tessera_core::market::{Aggressor, Bar, DepthLevel, FootprintCell, Trade};
use tessera_core::{Price, Qty, Timestamp};
use ts_rs::TS;

struct Num(f64);

impl Serialize for Num {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        const F64_EXACT_INTEGER_LIMIT: f64 = (1u64 << 53) as f64;
        if self.0.fract() == 0.0 && self.0.abs() < F64_EXACT_INTEGER_LIMIT {
            s.serialize_i64(self.0 as i64)
        } else {
            s.serialize_f64(self.0)
        }
    }
}

fn next<'de, T: Deserialize<'de>, A: SeqAccess<'de>>(
    seq: &mut A,
    i: usize,
    what: &'static str,
) -> Result<T, A::Error> {
    seq.next_element()?
        .ok_or_else(|| de::Error::invalid_length(i, &what))
}

#[derive(Clone, Copy, Debug, PartialEq, TS)]
#[ts(
    type = "[number, number, number, number, number, number] | [number, number, number, number, number, number, number]"
)]
pub struct CompactBar(
    pub i64,
    pub f64,
    pub f64,
    pub f64,
    pub f64,
    pub f64,
    pub Option<f64>,
);

impl From<&Bar> for CompactBar {
    fn from(b: &Bar) -> Self {
        CompactBar(
            b.t.0,
            b.o.to_f64(),
            b.h.to_f64(),
            b.l.to_f64(),
            b.c.to_f64(),
            b.v.to_f64(),
            b.bv.map(Qty::to_f64),
        )
    }
}

impl CompactBar {
    pub fn t(&self) -> Timestamp {
        Timestamp(self.0)
    }

    pub fn to_bar(&self) -> Option<Bar> {
        Some(Bar {
            t: Timestamp(self.0),
            o: Price::from_f64(self.1)?,
            h: Price::from_f64(self.2)?,
            l: Price::from_f64(self.3)?,
            c: Price::from_f64(self.4)?,
            v: Qty::from_f64(self.5)?,
            bv: match self.6 {
                Some(bv) => Some(Qty::from_f64(bv)?),
                None => None,
            },
        })
    }
}

impl JsonSchema for CompactBar {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "CompactBar".into()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "type": "array",
            "description": "Bar as [t, o, h, l, c, v, bv?]; t = bar open time, integer UTC nanoseconds; bv = aggressive buy volume when known (delta = 2·bv − v).",
            "prefixItems": [
                { "type": "integer" }, { "type": "number" }, { "type": "number" },
                { "type": "number" }, { "type": "number" }, { "type": "number" },
                { "type": "number" }
            ],
            "minItems": 6,
            "maxItems": 7
        })
    }
}

impl Serialize for CompactBar {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut t = s.serialize_tuple(if self.6.is_some() { 7 } else { 6 })?;
        t.serialize_element(&self.0)?;
        for v in [self.1, self.2, self.3, self.4, self.5] {
            t.serialize_element(&Num(v))?;
        }
        if let Some(bv) = self.6 {
            t.serialize_element(&Num(bv))?;
        }
        t.end()
    }
}

impl<'de> Deserialize<'de> for CompactBar {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = CompactBar;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("[t, o, h, l, c, v, bv?]")
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<CompactBar, A::Error> {
                const WHAT: &str = "6 or 7 elements";
                Ok(CompactBar(
                    next(&mut seq, 0, WHAT)?,
                    next(&mut seq, 1, WHAT)?,
                    next(&mut seq, 2, WHAT)?,
                    next(&mut seq, 3, WHAT)?,
                    next(&mut seq, 4, WHAT)?,
                    next(&mut seq, 5, WHAT)?,
                    seq.next_element()?,
                ))
            }
        }
        d.deserialize_seq(V)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, TS)]
#[ts(type = "[number, number] | [number, number, number]")]
pub struct CompactLevel(pub f64, pub f64, pub Option<u32>);

impl Serialize for CompactLevel {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut t = s.serialize_tuple(if self.2.is_some() { 3 } else { 2 })?;
        t.serialize_element(&Num(self.0))?;
        t.serialize_element(&Num(self.1))?;
        if let Some(n) = self.2 {
            t.serialize_element(&n)?;
        }
        t.end()
    }
}

impl<'de> Deserialize<'de> for CompactLevel {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = CompactLevel;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("[price, size, orders?]")
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<CompactLevel, A::Error> {
                const WHAT: &str = "2 or 3 elements";
                Ok(CompactLevel(
                    next(&mut seq, 0, WHAT)?,
                    next(&mut seq, 1, WHAT)?,
                    seq.next_element()?,
                ))
            }
        }
        d.deserialize_seq(V)
    }
}

impl From<&DepthLevel> for CompactLevel {
    fn from(l: &DepthLevel) -> Self {
        CompactLevel(l.price.to_f64(), l.size.to_f64(), l.orders)
    }
}

impl JsonSchema for CompactLevel {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "CompactLevel".into()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "type": "array",
            "description": "Depth level as [price, size, orders?]; orders only when the feed counts them.",
            "prefixItems": [{ "type": "number" }, { "type": "number" }, { "type": "integer" }],
            "minItems": 2,
            "maxItems": 3
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, TS)]
#[ts(type = "[number, number, number, number] | [number, number, number, number, number]")]
pub struct CompactTrade(pub i64, pub f64, pub f64, pub i8, pub Option<u32>);

impl From<&Trade> for CompactTrade {
    fn from(t: &Trade) -> Self {
        CompactTrade(
            t.ts.0,
            t.price.to_f64(),
            t.size.to_f64(),
            t.aggressor.sign(),
            t.order_key,
        )
    }
}

impl CompactTrade {
    pub fn aggressor(&self) -> Aggressor {
        Aggressor::from_sign(self.3)
    }
}

impl Serialize for CompactTrade {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut t = s.serialize_tuple(if self.4.is_some() { 5 } else { 4 })?;
        t.serialize_element(&self.0)?;
        t.serialize_element(&Num(self.1))?;
        t.serialize_element(&Num(self.2))?;
        t.serialize_element(&self.3)?;
        if let Some(o) = self.4 {
            t.serialize_element(&o)?;
        }
        t.end()
    }
}

impl<'de> Deserialize<'de> for CompactTrade {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = CompactTrade;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("[t, price, size, side, order?]")
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<CompactTrade, A::Error> {
                const WHAT: &str = "4 or 5 elements";
                Ok(CompactTrade(
                    next(&mut seq, 0, WHAT)?,
                    next(&mut seq, 1, WHAT)?,
                    next(&mut seq, 2, WHAT)?,
                    next(&mut seq, 3, WHAT)?,
                    seq.next_element()?,
                ))
            }
        }
        d.deserialize_seq(V)
    }
}

impl JsonSchema for CompactTrade {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "CompactTrade".into()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "type": "array",
            "description": "Print as [t, price, size, side, order?]; t = integer UTC nanoseconds; side 1 = buyer lifted the offer, -1 = seller hit the bid, 0 = unknown; order = key of the aggressor order when the feed names it (prints of one order share it).",
            "prefixItems": [
                { "type": "integer" }, { "type": "number" }, { "type": "number" },
                { "type": "integer", "enum": [-1, 0, 1] }, { "type": "integer" }
            ],
            "minItems": 4,
            "maxItems": 5
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Deserialize, TS)]
#[ts(type = "[number, number, number, number]")]
pub struct CompactCell(pub f64, pub f64, pub f64, pub u32);

impl From<&FootprintCell> for CompactCell {
    fn from(c: &FootprintCell) -> Self {
        CompactCell(
            c.price.to_f64(),
            c.bid_volume.to_f64(),
            c.ask_volume.to_f64(),
            c.trades,
        )
    }
}

impl Serialize for CompactCell {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut t = s.serialize_tuple(4)?;
        for v in [self.0, self.1, self.2, f64::from(self.3)] {
            t.serialize_element(&Num(v))?;
        }
        t.end()
    }
}

impl JsonSchema for CompactCell {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "CompactCell".into()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "type": "array",
            "description": "Footprint row as [price, bidVolume, askVolume, trades]: sellers hitting the bid and buyers lifting the offer at that price, and how many prints traded there.",
            "prefixItems": [{ "type": "number" }, { "type": "number" }, { "type": "number" }, { "type": "integer", "minimum": 0 }],
            "minItems": 4,
            "maxItems": 4
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;
    use tessera_core::InstrumentId;
    use tessera_core::market::AggressorSource;

    fn bar(bv: Option<i64>) -> Bar {
        Bar {
            t: Timestamp(1_790_966_400_000_000_000),
            o: Price::from_str("487.84").unwrap(),
            h: Price::from_str("488.01").unwrap(),
            l: Price::from_str("487.69").unwrap(),
            c: Price::from_str("487.85").unwrap(),
            v: Qty::from(183_000),
            bv: bv.map(Qty::from),
        }
    }

    #[test]
    fn bar_encodes_as_six_or_seven_element_array() {
        let plain = bar(None);
        let json = serde_json::to_string(&CompactBar::from(&plain)).unwrap();
        assert_eq!(
            json,
            "[1790966400000000000,487.84,488.01,487.69,487.85,183000]"
        );
        let back: CompactBar = serde_json::from_str(&json).unwrap();
        assert_eq!(back.to_bar().unwrap(), plain);

        let with_bv = bar(Some(97_500));
        let json = serde_json::to_string(&CompactBar::from(&with_bv)).unwrap();
        assert_eq!(
            json,
            "[1790966400000000000,487.84,488.01,487.69,487.85,183000,97500]"
        );
        let back: CompactBar = serde_json::from_str(&json).unwrap();
        assert_eq!(back.to_bar().unwrap(), with_bv);
        assert!(serde_json::from_str::<CompactBar>("[1,2,3,4,5]").is_err());
    }

    #[test]
    fn levels_carry_order_counts_when_known() {
        let mut lvl = DepthLevel {
            price: Price::from_str("20641.25").unwrap(),
            size: Qty::from(12),
            orders: None,
        };
        assert_eq!(
            serde_json::to_string(&CompactLevel::from(&lvl)).unwrap(),
            "[20641.25,12]"
        );
        lvl.orders = Some(4);
        let json = serde_json::to_string(&CompactLevel::from(&lvl)).unwrap();
        assert_eq!(json, "[20641.25,12,4]");
        let back: CompactLevel = serde_json::from_str(&json).unwrap();
        assert_eq!(back, CompactLevel(20641.25, 12.0, Some(4)));
        let back: CompactLevel = serde_json::from_str("[1.5,2]").unwrap();
        assert_eq!(back, CompactLevel(1.5, 2.0, None));
    }

    #[test]
    fn prints_and_footprint_rows() {
        let t = Trade {
            instrument: InstrumentId::new("NQZ6.CME").unwrap(),
            ts: Timestamp(1_790_966_400_123_000_000),
            price: Price::from_str("20641.25").unwrap(),
            size: Qty::from(3),
            aggressor: Aggressor::Sell,
            aggressor_source: AggressorSource::Exchange,
            order_key: None,
            source: None,
        };
        let c = CompactTrade::from(&t);
        let json = serde_json::to_string(&c).unwrap();
        assert_eq!(json, "[1790966400123000000,20641.25,3,-1]");
        assert_eq!(serde_json::from_str::<CompactTrade>(&json).unwrap(), c);
        assert_eq!(c.aggressor(), Aggressor::Sell);
        let keyed = CompactTrade::from(&Trade {
            order_key: Some(7),
            ..t
        });
        let json = serde_json::to_string(&keyed).unwrap();
        assert_eq!(json, "[1790966400123000000,20641.25,3,-1,7]");
        assert_eq!(serde_json::from_str::<CompactTrade>(&json).unwrap(), keyed);
        let cell = CompactCell::from(&FootprintCell {
            price: Price::from_str("20641.25").unwrap(),
            bid_volume: Qty::from(4),
            ask_volume: Qty::from(11),
            trades: 6,
        });
        assert_eq!(serde_json::to_string(&cell).unwrap(), "[20641.25,4,11,6]");
    }
}
