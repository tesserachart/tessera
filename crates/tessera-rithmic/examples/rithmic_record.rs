use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use rithmic_rs::rti::messages::RithmicMessage;
use rithmic_rs::{
    ConnectStrategy, RithmicConfig, RithmicEnv, RithmicHistoryPlant, RithmicTickerPlant,
    TimeBarType,
};
use tessera_rithmic::credentials::{APP_NAME, RithmicLogin};
use tessera_rithmic::frames::{FrameWriter, compress};

type Writer = Arc<Mutex<FrameWriter<Vec<u8>>>>;

fn record(w: &Writer, msg: &RithmicMessage) {
    let _ = w.lock().write(msg);
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let root = args.next().unwrap_or_else(|| "ES".into()).to_uppercase();
    let seconds: u64 = args.next().and_then(|s| s.parse().ok()).unwrap_or(3);
    let out = args
        .next()
        .unwrap_or_else(|| format!("{}-mbo.rframes.zst", root.to_lowercase()));
    let login = RithmicLogin::from_default_file()?;
    let config = RithmicConfig::builder(RithmicEnv::Live)
        .url(login.gateway_url.clone())
        .beta_url(login.gateway_url.clone())
        .user(login.user.clone())
        .password(login.password.clone())
        .system_name(login.system_name.clone())
        .app_name(APP_NAME)
        .app_version(env!("CARGO_PKG_VERSION"))
        .build()?;
    let redact = |e: &dyn std::fmt::Display| login.redact(&e.to_string());
    let w: Writer = Arc::new(Mutex::new(FrameWriter::new(Vec::new())));

    let plant = RithmicTickerPlant::connect(&config, ConnectStrategy::Simple)
        .await
        .map_err(|e| redact(&e))?;
    let ticker = plant.get_handle();
    ticker.login().await.map_err(|e| redact(&e))?;
    let front = ticker
        .get_front_month_contract(&root, "CME", false)
        .await
        .map_err(|e| redact(&e))?;
    record(&w, &front.message);
    let RithmicMessage::ResponseFrontMonthContract(f) = &front.message else {
        return Err("no front month reply".into());
    };
    let symbol = f
        .trading_symbol
        .clone()
        .ok_or("front month has no symbol")?;
    let exchange = f
        .trading_exchange
        .clone()
        .unwrap_or_else(|| "CME".to_owned());
    println!("recording {symbol}.{exchange} for {seconds}s");
    let reference = ticker
        .get_reference_data(&symbol, &exchange)
        .await
        .map_err(|e| redact(&e))?;
    record(&w, &reference.message);

    let mut rx = ticker.subscription_receiver.resubscribe();
    let tap = Arc::clone(&w);
    let reader = tokio::spawn(async move {
        while let Ok(u) = rx.recv().await {
            if u.error.as_ref().is_some_and(|e| e.is_connection_issue()) {
                break;
            }
            record(&tap, &u.message);
        }
    });
    ticker.subscribe(&symbol, &exchange).await?;
    ticker.subscribe_session_prices(&symbol, &exchange).await?;
    ticker
        .subscribe_depth_by_order_update(&symbol, &exchange)
        .await?;
    let snapshot = ticker
        .get_depth_by_order_snapshot(&symbol, &exchange)
        .await?;
    {
        let mut writer = w.lock();
        for frame in &snapshot {
            let _ = writer.write(&frame.message);
        }
    }
    tokio::time::sleep(Duration::from_secs(seconds)).await;
    let _ = ticker
        .unsubscribe_depth_by_order_update(&symbol, &exchange)
        .await;
    let _ = ticker.unsubscribe(&symbol, &exchange).await;
    let _ = ticker.disconnect().await;
    reader.abort();

    let history = RithmicHistoryPlant::connect(&config, ConnectStrategy::Simple)
        .await
        .map_err(|e| redact(&e))?;
    let h = history.get_handle();
    h.login().await.map_err(|e| redact(&e))?;
    let end = i32::try_from(chrono::Utc::now().timestamp())?;
    let bars = h
        .load_time_bars(
            symbol.clone(),
            exchange.clone(),
            TimeBarType::MinuteBar,
            1,
            end - 30 * 60,
            end,
        )
        .await?;
    for b in &bars {
        record(&w, &b.message);
    }
    let _ = h.disconnect().await;

    let writer = Arc::try_unwrap(w)
        .map_err(|_| "recorder still shared")?
        .into_inner();
    let frames = writer.frames();
    let raw = writer.into_inner();
    let packed = compress(&raw)?;
    std::fs::write(&out, &packed)?;
    println!(
        "{frames} frames, {} bytes raw, {} bytes packed -> {out}",
        raw.len(),
        packed.len()
    );
    Ok(())
}
