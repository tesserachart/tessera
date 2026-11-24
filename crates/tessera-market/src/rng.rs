const GOLDEN_GAMMA: u64 = 0x9E37_79B9_7F4A_7C15;

const KNUTH_MAX_LAMBDA: f64 = 30.0;

#[inline]
pub fn splitmix64(mut z: u64) -> u64 {
    z = z.wrapping_add(GOLDEN_GAMMA);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

#[inline]
pub fn hash3(seed: u64, stream: u64, index: i64) -> u64 {
    splitmix64(
        seed ^ splitmix64(stream.wrapping_mul(0xD6E8_FEB8_6659_FD93) ^ splitmix64(index as u64)),
    )
}

#[inline]
pub fn unit(h: u64) -> f64 {
    ((h >> 11) as f64 + 0.5) / (1u64 << 53) as f64
}

pub fn normal(seed: u64, stream: u64, index: i64) -> f64 {
    let u1 = unit(hash3(seed, stream, index));
    let u2 = unit(hash3(seed, stream ^ 0xA5A5_A5A5_A5A5_A5A5, index));
    box_muller(u1, u2)
}

fn box_muller(u1: f64, u2: f64) -> f64 {
    (-2.0 * u1.ln()).sqrt() * (std::f64::consts::TAU * u2).cos()
}

pub fn uniform(seed: u64, stream: u64, index: i64) -> f64 {
    unit(hash3(seed, stream ^ 0x5A5A_5A5A_5A5A_5A5A, index))
}

#[derive(Clone, Debug)]
pub struct SplitMix {
    state: u64,
}

impl SplitMix {
    pub fn new(seed: u64) -> Self {
        Self { state: seed }
    }

    pub fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(GOLDEN_GAMMA);
        splitmix64(self.state)
    }

    pub fn uniform(&mut self) -> f64 {
        unit(self.next_u64())
    }

    pub fn normal(&mut self) -> f64 {
        let u1 = self.uniform();
        let u2 = self.uniform();
        box_muller(u1, u2)
    }

    pub fn poisson(&mut self, lambda: f64) -> u32 {
        if lambda <= 0.0 {
            return 0;
        }
        if lambda > KNUTH_MAX_LAMBDA {
            return (lambda + lambda.sqrt() * self.normal()).round().max(0.0) as u32;
        }
        let l = (-lambda).exp();
        let mut k = 0;
        let mut p = 1.0;
        loop {
            p *= self.uniform();
            if p <= l {
                return k;
            }
            k += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_normals_are_deterministic_and_standard() {
        assert_eq!(normal(1, 2, 3), normal(1, 2, 3));
        assert_ne!(normal(1, 2, 3), normal(2, 2, 3));
        let n = 200_000;
        let xs: Vec<f64> = (0..n).map(|i| normal(42, 7, i)).collect();
        let mean = xs.iter().sum::<f64>() / n as f64;
        let var = xs.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / n as f64;
        assert!(mean.abs() < 0.01, "mean {mean}");
        assert!((var - 1.0).abs() < 0.02, "var {var}");
    }

    #[test]
    fn unit_never_reaches_zero() {
        assert!(unit(0) > 0.0);
        assert!(unit(u64::MAX) <= 1.0);
    }

    #[test]
    fn splitmix_poisson_mean() {
        let mut r = SplitMix::new(9);
        let n = 50_000;
        let total: u64 = (0..n).map(|_| u64::from(r.poisson(3.5))).sum();
        let mean = total as f64 / n as f64;
        assert!((mean - 3.5).abs() < 0.05, "mean {mean}");
        assert_eq!(r.poisson(0.0), 0);
    }
}
