//! The workspace's `serde_json::Map` sorts its keys; turning on its `preserve_order` feature
//! would change every other JSON the runtime writes.

use std::fmt;

use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde::ser::{SerializeMap, SerializeSeq};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

#[derive(Clone, Debug, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Number(serde_json::Number),
    String(String),
    Array(Vec<Json>),
    Object(Vec<(String, Json)>),
}

impl Json {
    pub fn str(s: impl Into<String>) -> Self {
        Json::String(s.into())
    }

    pub fn object<K: Into<String>>(fields: impl IntoIterator<Item = (K, Json)>) -> Self {
        Json::Object(fields.into_iter().map(|(k, v)| (k.into(), v)).collect())
    }

    pub fn entry<'a>(
        fields: &'a mut Vec<(String, Json)>,
        key: &str,
        default: Json,
    ) -> &'a mut Json {
        let at = match fields.iter().position(|(k, _)| k == key) {
            Some(i) => i,
            None => {
                fields.push((key.to_owned(), default));
                fields.len() - 1
            }
        };
        &mut fields[at].1
    }

    pub fn set(fields: &mut Vec<(String, Json)>, key: &str, value: Json) {
        *Self::entry(fields, key, Json::Null) = value;
    }

    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Object(fields) => fields.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn pretty(&self) -> String {
        serde_json::to_string_pretty(self).unwrap_or_else(|_| "null".to_owned())
    }
}

impl Serialize for Json {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Json::Null => s.serialize_unit(),
            Json::Bool(b) => s.serialize_bool(*b),
            Json::Number(n) => n.serialize(s),
            Json::String(v) => s.serialize_str(v),
            Json::Array(items) => {
                let mut seq = s.serialize_seq(Some(items.len()))?;
                for item in items {
                    seq.serialize_element(item)?;
                }
                seq.end()
            }
            Json::Object(fields) => {
                let mut map = s.serialize_map(Some(fields.len()))?;
                for (k, v) in fields {
                    map.serialize_entry(k, v)?;
                }
                map.end()
            }
        }
    }
}

struct JsonVisitor;

impl<'de> Visitor<'de> for JsonVisitor {
    type Value = Json;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("any JSON value")
    }

    fn visit_bool<E>(self, v: bool) -> Result<Json, E> {
        Ok(Json::Bool(v))
    }

    fn visit_i64<E>(self, v: i64) -> Result<Json, E> {
        Ok(Json::Number(v.into()))
    }

    fn visit_u64<E>(self, v: u64) -> Result<Json, E> {
        Ok(Json::Number(v.into()))
    }

    fn visit_f64<E: de::Error>(self, v: f64) -> Result<Json, E> {
        serde_json::Number::from_f64(v)
            .map(Json::Number)
            .ok_or_else(|| E::custom("a number JSON cannot hold"))
    }

    fn visit_str<E>(self, v: &str) -> Result<Json, E> {
        Ok(Json::String(v.to_owned()))
    }

    fn visit_string<E>(self, v: String) -> Result<Json, E> {
        Ok(Json::String(v))
    }

    fn visit_unit<E>(self) -> Result<Json, E> {
        Ok(Json::Null)
    }

    fn visit_none<E>(self) -> Result<Json, E> {
        Ok(Json::Null)
    }

    fn visit_some<D: Deserializer<'de>>(self, d: D) -> Result<Json, D::Error> {
        Json::deserialize(d)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Json, A::Error> {
        let mut items = Vec::new();
        while let Some(item) = seq.next_element()? {
            items.push(item);
        }
        Ok(Json::Array(items))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Json, A::Error> {
        let mut fields: Vec<(String, Json)> = Vec::new();
        while let Some((k, v)) = map.next_entry::<String, Json>()? {
            Json::set(&mut fields, &k, v);
        }
        Ok(Json::Object(fields))
    }
}

impl<'de> Deserialize<'de> for Json {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Json, D::Error> {
        d.deserialize_any(JsonVisitor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_keep_their_order_through_a_round_trip() {
        let text = r#"{"zeta": 1, "alpha": {"b": [true, null, 2.5], "a": "x"}, "mid": -3}"#;
        let v: Json = serde_json::from_str(text).unwrap();
        let back = serde_json::to_string(&v).unwrap();
        assert_eq!(
            back,
            r#"{"zeta":1,"alpha":{"b":[true,null,2.5],"a":"x"},"mid":-3}"#
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&back).unwrap(),
            serde_json::from_str::<serde_json::Value>(text).unwrap()
        );
    }

    #[test]
    fn set_replaces_in_place_or_appends() {
        let mut fields = vec![("a".to_owned(), Json::Null), ("b".to_owned(), Json::Null)];
        Json::set(&mut fields, "a", Json::str("x"));
        Json::set(&mut fields, "c", Json::Bool(true));
        let keys: Vec<&str> = fields.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, ["a", "b", "c"]);
        assert_eq!(fields[0].1, Json::str("x"));
    }
}
