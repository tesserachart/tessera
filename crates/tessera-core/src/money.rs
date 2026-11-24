use std::borrow::Cow;
use std::fmt;
use std::ops::{Add, Neg, Sub};
use std::str::FromStr;

use rust_decimal::prelude::{FromPrimitive, ToPrimitive};
use rust_decimal::{Decimal, RoundingStrategy};
use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use ts_rs::TS;

pub mod decimal_number {
    use super::*;

    pub fn serialize<S: Serializer>(value: &Decimal, serializer: S) -> Result<S::Ok, S::Error> {
        if value.fract().is_zero()
            && let Some(i) = value.to_i64()
        {
            return serializer.serialize_i64(i);
        }
        // serde_json writes an f64 in its shortest round-trip form.
        let f = value
            .to_f64()
            .ok_or_else(|| serde::ser::Error::custom("decimal out of f64 range"))?;
        serializer.serialize_f64(f)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Decimal, D::Error> {
        deserializer.deserialize_any(DecimalVisitor)
    }

    struct DecimalVisitor;

    impl serde::de::Visitor<'_> for DecimalVisitor {
        type Value = Decimal;

        fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("a number or a decimal string")
        }

        fn visit_i64<E: serde::de::Error>(self, v: i64) -> Result<Decimal, E> {
            Ok(Decimal::from(v))
        }

        fn visit_u64<E: serde::de::Error>(self, v: u64) -> Result<Decimal, E> {
            Ok(Decimal::from(v))
        }

        fn visit_f64<E: serde::de::Error>(self, v: f64) -> Result<Decimal, E> {
            decimal_from_f64(v).ok_or_else(|| E::custom(format!("invalid decimal number {v}")))
        }

        fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<Decimal, E> {
            Decimal::from_str(v.trim())
                .or_else(|_| Decimal::from_scientific(v.trim()))
                .map_err(|e| E::custom(format!("invalid decimal string {v:?}: {e}")))
        }
    }
}

pub fn decimal_from_f64(v: f64) -> Option<Decimal> {
    if !v.is_finite() {
        return None;
    }
    // Rust's `Display` for f64 prints the shortest string that round-trips.
    let s = format!("{v}");
    Decimal::from_str(&s)
        .or_else(|_| Decimal::from_scientific(&s))
        .ok()
        .or_else(|| Decimal::from_f64(v))
}

macro_rules! decimal_newtype {
    ($(#[$meta:meta])* $name:ident, $schema_desc:expr) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash, TS)]
        #[ts(type = "number")]
        pub struct $name(pub Decimal);

        impl $name {
            pub const ZERO: Self = Self(Decimal::ZERO);

            pub const fn new(value: Decimal) -> Self {
                Self(value)
            }

            pub const fn value(self) -> Decimal {
                self.0
            }

            pub fn to_f64(self) -> f64 {
                self.0.to_f64().unwrap_or(f64::NAN)
            }

            pub fn from_f64(v: f64) -> Option<Self> {
                decimal_from_f64(v).map(Self)
            }

            pub fn abs(self) -> Self {
                Self(self.0.abs())
            }

            pub fn is_zero(self) -> bool {
                self.0.is_zero()
            }
        }

        impl From<Decimal> for $name {
            fn from(value: Decimal) -> Self {
                Self(value)
            }
        }

        impl From<i64> for $name {
            fn from(value: i64) -> Self {
                Self(Decimal::from(value))
            }
        }

        impl From<$name> for Decimal {
            fn from(value: $name) -> Decimal {
                value.0
            }
        }

        impl FromStr for $name {
            type Err = rust_decimal::Error;
            fn from_str(s: &str) -> Result<Self, Self::Err> {
                Decimal::from_str(s.trim()).map(Self)
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                fmt::Display::fmt(&self.0, f)
            }
        }

        impl Add for $name {
            type Output = Self;
            fn add(self, rhs: Self) -> Self {
                Self(self.0 + rhs.0)
            }
        }

        impl Sub for $name {
            type Output = Self;
            fn sub(self, rhs: Self) -> Self {
                Self(self.0 - rhs.0)
            }
        }

        impl Neg for $name {
            type Output = Self;
            fn neg(self) -> Self {
                Self(-self.0)
            }
        }

        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                decimal_number::serialize(&self.0, serializer)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                decimal_number::deserialize(deserializer).map(Self)
            }
        }

        impl JsonSchema for $name {
            fn inline_schema() -> bool {
                true
            }

            fn schema_name() -> Cow<'static, str> {
                Cow::Borrowed(stringify!($name))
            }

            fn json_schema(_: &mut SchemaGenerator) -> Schema {
                json_schema!({ "type": "number", "description": $schema_desc })
            }
        }
    };
}

decimal_newtype!(
    Price,
    "Price as a decimal number, quantized to the instrument tick."
);

decimal_newtype!(
    Qty,
    "Quantity as a decimal number (shares, contracts or coins)."
);

/// ISO 4217-style currency code (crypto assets use their ticker).
#[derive(
    Clone,
    Copy,
    Debug,
    Default,
    PartialEq,
    Eq,
    PartialOrd,
    Ord,
    Hash,
    Serialize,
    Deserialize,
    TS,
    JsonSchema,
)]
#[serde(rename_all = "UPPERCASE")]
pub enum Currency {
    /// US dollar.
    #[default]
    Usd,
    /// Euro.
    Eur,
    /// Pound sterling.
    Gbp,
    /// USD Coin.
    Usdc,
    /// Bitcoin.
    Btc,
    /// Ether.
    Eth,
}

impl Currency {
    pub fn code(self) -> &'static str {
        match self {
            Currency::Usd => "USD",
            Currency::Eur => "EUR",
            Currency::Gbp => "GBP",
            Currency::Usdc => "USDC",
            Currency::Btc => "BTC",
            Currency::Eth => "ETH",
        }
    }
}

impl fmt::Display for Currency {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}

/// An amount of money in a currency.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Money {
    /// The amount, as a decimal number.
    #[serde(with = "decimal_number")]
    #[ts(type = "number")]
    #[schemars(with = "f64")]
    pub amount: Decimal,
    /// Currency of the amount.
    pub currency: Currency,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum MoneyError {
    #[error("currency mismatch: {0} vs {1}")]
    CurrencyMismatch(Currency, Currency),
}

impl Money {
    pub const fn new(amount: Decimal, currency: Currency) -> Self {
        Self { amount, currency }
    }

    pub const fn usd(amount: Decimal) -> Self {
        Self::new(amount, Currency::Usd)
    }

    pub const fn zero(currency: Currency) -> Self {
        Self::new(Decimal::ZERO, currency)
    }

    pub fn checked_sub(self, other: Money) -> Result<Money, MoneyError> {
        self.same_currency(other)?;
        Ok(Money::new(self.amount - other.amount, self.currency))
    }

    pub fn scale(self, factor: Decimal) -> Money {
        Money::new(self.amount * factor, self.currency)
    }

    pub fn round_cents(self) -> Money {
        Money::new(
            self.amount
                .round_dp_with_strategy(2, RoundingStrategy::MidpointAwayFromZero),
            self.currency,
        )
    }

    fn same_currency(self, other: Money) -> Result<(), MoneyError> {
        if self.currency == other.currency {
            Ok(())
        } else {
            Err(MoneyError::CurrencyMismatch(self.currency, other.currency))
        }
    }
}

impl fmt::Display for Money {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} {}", self.amount.round_dp(2), self.currency)
    }
}

/// How to snap a value onto a tick grid.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Rounding {
    /// Nearest tick; exact midpoints round away from zero.
    Nearest,
    /// Toward negative infinity.
    Down,
    /// Toward positive infinity.
    Up,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TickError {
    #[error("tick size must be positive, got {0}")]
    InvalidTick(Decimal),
    #[error("{value} is not on the {tick} tick grid")]
    OffTick { value: Decimal, tick: Decimal },
    #[error("tick count overflow")]
    Overflow,
}

pub fn quantize(value: Decimal, tick: Decimal, mode: Rounding) -> Result<Decimal, TickError> {
    if tick <= Decimal::ZERO {
        return Err(TickError::InvalidTick(tick));
    }
    let strategy = match mode {
        Rounding::Nearest => RoundingStrategy::MidpointAwayFromZero,
        Rounding::Down => RoundingStrategy::ToNegativeInfinity,
        Rounding::Up => RoundingStrategy::ToPositiveInfinity,
    };
    let steps = (value / tick).round_dp_with_strategy(0, strategy);
    let mut out = steps * tick;
    out.rescale(tick.scale());
    Ok(out)
}

pub fn is_on_tick(value: Decimal, tick: Decimal) -> bool {
    tick > Decimal::ZERO && (value % tick).is_zero()
}

pub fn ticks_in(delta: Decimal, tick: Decimal) -> Result<i64, TickError> {
    if tick <= Decimal::ZERO {
        return Err(TickError::InvalidTick(tick));
    }
    if !is_on_tick(delta, tick) {
        return Err(TickError::OffTick { value: delta, tick });
    }
    (delta / tick).to_i64().ok_or(TickError::Overflow)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> Decimal {
        Decimal::from_str(s).unwrap()
    }

    #[test]
    fn price_round_trips_as_shortest_json_number() {
        let p = Price(d("487.85"));
        let json = serde_json::to_string(&p).unwrap();
        assert_eq!(json, "487.85");
        let back: Price = serde_json::from_str(&json).unwrap();
        assert_eq!(back, p);
        let from_str: Price = serde_json::from_str("\"20641.25\"").unwrap();
        assert_eq!(from_str.0, d("20641.25"));
        let from_int: Qty = serde_json::from_str("25").unwrap();
        assert_eq!(from_int.0, d("25"));
    }

    #[test]
    fn decimal_from_f64_is_exact_for_shortest_repr() {
        assert_eq!(decimal_from_f64(0.1).unwrap(), d("0.1"));
        assert_eq!(decimal_from_f64(98412.0).unwrap(), d("98412"));
        assert_eq!(decimal_from_f64(1e-8).unwrap(), d("0.00000001"));
        assert!(decimal_from_f64(f64::NAN).is_none());
    }

    #[test]
    fn quantize_to_quarter_tick() {
        let tick = d("0.25");
        assert_eq!(
            quantize(d("20893.368"), tick, Rounding::Nearest).unwrap(),
            d("20893.25")
        );
        assert_eq!(
            quantize(d("20943.47"), tick, Rounding::Nearest).unwrap(),
            d("20943.50")
        );
        assert_eq!(
            quantize(d("20652.87"), tick, Rounding::Nearest).unwrap(),
            d("20652.75")
        );
        assert_eq!(
            quantize(d("20652.875"), tick, Rounding::Nearest).unwrap(),
            d("20653.00")
        );
        assert_eq!(
            quantize(d("20652.80"), tick, Rounding::Down).unwrap(),
            d("20652.75")
        );
        assert_eq!(
            quantize(d("20652.80"), tick, Rounding::Up).unwrap(),
            d("20653.00")
        );
        assert_eq!(
            quantize(d("-1.13"), tick, Rounding::Nearest).unwrap(),
            d("-1.25")
        );
        assert!(quantize(d("1"), Decimal::ZERO, Rounding::Nearest).is_err());
        assert_eq!(
            quantize(d("20893.2500"), tick, Rounding::Nearest)
                .unwrap()
                .scale(),
            2
        );
    }

    #[test]
    fn ticks_and_grid_checks() {
        assert!(is_on_tick(d("487.85"), d("0.01")));
        assert!(!is_on_tick(d("487.855"), d("0.01")));
        assert_eq!(ticks_in(d("118.25"), d("0.25")).unwrap(), 473);
        assert_eq!(ticks_in(d("-0.60"), d("0.01")).unwrap(), -60);
        assert!(matches!(
            ticks_in(d("0.1"), d("0.25")),
            Err(TickError::OffTick { .. })
        ));
    }

    #[test]
    fn money_arithmetic_checks_currency() {
        let a = Money::usd(d("124820.00"));
        let eur = Money::new(d("1"), Currency::Eur);
        assert_eq!(
            a.checked_sub(eur),
            Err(MoneyError::CurrencyMismatch(Currency::Usd, Currency::Eur))
        );
        assert_eq!(Money::usd(d("48.745")).round_cents().amount, d("48.75"));
        let json = serde_json::to_value(Money::usd(d("12181.25"))).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"amount": 12181.25, "currency": "USD"})
        );
    }
}
