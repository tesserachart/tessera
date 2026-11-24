pub fn wilson_interval(successes: u64, n: u64, z: f64) -> Option<(f64, f64)> {
    if n == 0 || successes > n {
        return None;
    }
    let n_f = n as f64;
    let p = successes as f64 / n_f;
    let z2 = z * z;
    let denom = 1.0 + z2 / n_f;
    let centre = (p + z2 / (2.0 * n_f)) / denom;
    let half = z * (p * (1.0 - p) / n_f + z2 / (4.0 * n_f * n_f)).sqrt() / denom;
    Some((centre - half, centre + half))
}

pub fn two_proportion_z(x1: u64, n1: u64, x2: u64, n2: u64) -> Option<f64> {
    if n1 == 0 || n2 == 0 {
        return None;
    }
    let (p1, p2) = (x1 as f64 / n1 as f64, x2 as f64 / n2 as f64);
    let pooled = (x1 + x2) as f64 / (n1 + n2) as f64;
    let se = (pooled * (1.0 - pooled) * (1.0 / n1 as f64 + 1.0 / n2 as f64)).sqrt();
    (se > 0.0).then(|| (p1 - p2) / se)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pct(x: f64) -> f64 {
        (x * 1000.0).round() / 10.0
    }

    #[test]
    fn matches_the_content_sheet_event_study() {
        let (lo, hi) = wilson_interval(258, 418, 1.96).unwrap();
        assert_eq!((pct(lo), pct(hi)), (57.0, 66.3));
        let (lo, hi) = wilson_interval(2169, 4180, 1.96).unwrap();
        assert_eq!((pct(lo), pct(hi)), (50.4, 53.4));
        let z = two_proportion_z(258, 418, 2169, 4180).unwrap();
        assert!((z - 3.84).abs() < 0.01, "z {z}");
        let (lo, hi) = wilson_interval(66, 104, 1.96).unwrap();
        assert_eq!((pct(lo), pct(hi)), (53.9, 72.1));
        assert!(wilson_interval(1, 0, 1.96).is_none());
        assert!(two_proportion_z(0, 0, 1, 1).is_none());
    }
}
