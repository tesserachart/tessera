use rust_decimal::Decimal;

use crate::error::{Result, StoreError};

const MAX_SCALE: u32 = 28;

pub(crate) struct Reader<'a> {
    buf: &'a [u8],
    at: usize,
    what: &'static str,
}

impl<'a> Reader<'a> {
    pub(crate) fn new(buf: &'a [u8], what: &'static str) -> Self {
        Self { buf, at: 0, what }
    }

    pub(crate) fn done(&self) -> bool {
        self.at == self.buf.len()
    }

    pub(crate) fn malformed(&self, why: &str) -> StoreError {
        StoreError::Invalid(format!("{} is malformed: {why}", self.what))
    }

    pub(crate) fn byte(&mut self) -> Result<u8> {
        let b = *self
            .buf
            .get(self.at)
            .ok_or_else(|| StoreError::Invalid(format!("{} is truncated", self.what)))?;
        self.at += 1;
        Ok(b)
    }

    pub(crate) fn varint(&mut self) -> Result<u64> {
        let mut v = 0u64;
        let mut shift = 0;
        loop {
            let b = self.byte()?;
            if shift > 63 {
                return Err(StoreError::Invalid(format!(
                    "{} has a bad number",
                    self.what
                )));
            }
            v |= u64::from(b & 0x7f) << shift;
            if b < 0x80 {
                return Ok(v);
            }
            shift += 7;
        }
    }

    pub(crate) fn signed(&mut self) -> Result<i64> {
        Ok(unzigzag(self.varint()?))
    }

    pub(crate) fn head(&mut self, format: u8) -> Result<(Scales, Vec<i64>)> {
        if self.byte()? != format {
            return Err(self.malformed("unknown format"));
        }
        let n = usize::try_from(self.varint()?).map_err(|_| self.malformed("length"))?;
        if n > self.buf.len() {
            return Err(self.malformed("length"));
        }
        let scales = Scales {
            price: u32::from(self.byte()?),
            qty: u32::from(self.byte()?),
        };
        if scales.price > MAX_SCALE || scales.qty > MAX_SCALE {
            return Err(self.malformed("scale"));
        }
        let mut times = Vec::with_capacity(n);
        let mut prev = 0i64;
        for _ in 0..n {
            prev = prev.wrapping_add(self.signed()?);
            times.push(prev);
        }
        Ok((scales, times))
    }
}

#[derive(Clone, Copy)]
pub(crate) struct Scales {
    pub(crate) price: u32,
    pub(crate) qty: u32,
}

impl Scales {
    pub(crate) fn of(
        prices: impl Iterator<Item = Decimal>,
        qtys: impl Iterator<Item = Decimal>,
    ) -> Self {
        Self {
            price: widest(prices),
            qty: widest(qtys),
        }
    }
}

fn widest(ds: impl Iterator<Item = Decimal>) -> u32 {
    ds.map(|d| d.normalize().scale()).max().unwrap_or(0)
}

pub(crate) fn put_head(out: &mut Vec<u8>, format: u8, scales: Scales, times: &[i64]) {
    out.push(format);
    put(out, times.len() as u64);
    out.push(scales.price as u8);
    out.push(scales.qty as u8);
    let mut prev = 0i64;
    for &t in times {
        put(out, zigzag(t.wrapping_sub(prev)));
        prev = t;
    }
}

pub(crate) fn mantissa(d: Decimal, scale: u32, what: &str) -> Result<i64> {
    let mut d = d;
    d.rescale(scale);
    i64::try_from(d.mantissa()).map_err(|_| StoreError::Invalid(format!("{d} does not fit {what}")))
}

pub(crate) fn decimal(mantissa: i64, scale: u32) -> Decimal {
    Decimal::new(mantissa, scale).normalize()
}

pub(crate) fn put(buf: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        buf.push((v as u8) | 0x80);
        v >>= 7;
    }
    buf.push(v as u8);
}

pub(crate) fn zigzag(v: i64) -> u64 {
    ((v << 1) ^ (v >> 63)) as u64
}

pub(crate) fn unzigzag(v: u64) -> i64 {
    ((v >> 1) as i64) ^ -((v & 1) as i64)
}
