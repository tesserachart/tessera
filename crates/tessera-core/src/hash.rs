use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

pub fn canonical_json(value: &Value) -> String {
    let mut out = String::new();
    write_canonical(value, &mut out);
    out
}

fn write_canonical(value: &Value, out: &mut String) {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String((*k).clone()).to_string());
                out.push(':');
                write_canonical(&map[*k], out);
            }
            out.push('}');
        }
        Value::Array(items) => {
            out.push('[');
            for (i, v) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(v, out);
            }
            out.push(']');
        }
        other => out.push_str(&other.to_string()),
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

pub fn hash_json(value: &Value) -> String {
    sha256_hex(canonical_json(value).as_bytes())
}

pub fn hash_serializable<T: Serialize>(value: &T) -> Result<String, serde_json::Error> {
    Ok(hash_json(&serde_json::to_value(value)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn key_order_does_not_change_the_hash() {
        let a = json!({"b": 1, "a": {"y": [1, 2, {"q": true, "p": null}], "x": "s"}});
        let b = json!({"a": {"x": "s", "y": [1, 2, {"p": null, "q": true}]}, "b": 1});
        assert_eq!(canonical_json(&a), canonical_json(&b));
        assert_eq!(hash_json(&a), hash_json(&b));
        assert_eq!(
            canonical_json(&a),
            r#"{"a":{"x":"s","y":[1,2,{"p":null,"q":true}]},"b":1}"#
        );
    }

    #[test]
    fn known_digest() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_ne!(
            hash_json(&json!({"qty": 25})),
            hash_json(&json!({"qty": 26}))
        );
    }
}
