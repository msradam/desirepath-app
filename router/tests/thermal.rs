//! Thermal cost regression tests.
//!
//! The cost is a distance-inflating coefficient on thermal exposure, after
//! Melnikov et al. (2022), Scientific Reports 12:2441:
//!
//!     cost = length * (1 + (beta - 1) * exposure)
//!
//! where exposure interpolates the edge's mean radiant temperature between a
//! shade anchor and a sun anchor. Four properties matter:
//!
//!   1. A v2 binary still loads and carries no `mrt` attribute, so routes over
//!      it are byte-identical to the pre-thermal router.
//!   2. An edge at or below the shade anchor pays nothing. This is the same as
//!      an unsurveyed edge pays, which is what stops the router being paid to
//!      leave the surveyed area.
//!   3. Inflation is linear in exposure and reaches exactly beta - 1 at the
//!      sun anchor.
//!   4. The three shipped profiles carry the same thermal block.

use std::collections::HashMap;

use serde_json::{json, Value};
use unweaver_wasm::cost::eval_cost;
use unweaver_wasm::graph::OswGraph;
use unweaver_wasm::profile::Profile;

const GENERIC: &str = include_str!("../examples/profile-generic_pedestrian.json");
const WHEELCHAIR: &str = include_str!("../examples/profile-manual_wheelchair.json");
const LOW_VISION: &str = include_str!("../examples/profile-low_vision.json");

/// Melnikov et al. (2022) population mean beta, minus one.
const BETA_MEAN_INFLATION: f64 = 0.16;

fn tiny_binary(version: u8, mrt: u8) -> Vec<u8> {
    let mut b = Vec::new();
    b.extend_from_slice(b"OSWB");
    b.push(version);
    b.extend_from_slice(&[0, 0, 0]);
    b.extend_from_slice(&2u32.to_le_bytes());
    b.extend_from_slice(&1u32.to_le_bytes());

    for (lon, lat) in [(-73.91f32, 40.66f32), (-73.909f32, 40.66f32)] {
        b.extend_from_slice(&lon.to_le_bytes());
        b.extend_from_slice(&lat.to_le_bytes());
        b.push(0);
        b.push(0);
    }

    b.extend_from_slice(&0u32.to_le_bytes());
    b.extend_from_slice(&1u32.to_le_bytes());
    b.extend_from_slice(&100.0f32.to_le_bytes());
    b.extend_from_slice(&0i16.to_le_bytes());
    b.push(0);
    b.push(1);
    b.push(0);
    b.push(0);
    if version >= 3 {
        b.push(mrt);
    }
    b
}

fn edge_attrs(graph: &OswGraph) -> HashMap<String, Value> {
    let idx = graph.graph.edge_indices().next().expect("one edge");
    graph.graph[idx].attrs.clone()
}

fn cost_with(profile_json: &str, attrs: &HashMap<String, Value>, overrides: Value) -> Option<f64> {
    let profile = Profile::from_json(profile_json).unwrap();
    let supplied: HashMap<String, Value> = overrides
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    let args = profile.resolve_args(supplied).unwrap();
    eval_cost(&profile.cost, attrs, &args)
}

/// Encode a temperature the way the exporter does.
fn mrt_byte(celsius: f64) -> u8 {
    (((celsius - 20.0) / 0.5).round() as i64).clamp(1, 255) as u8
}

fn anchors() -> (f64, f64) {
    let v: Value = serde_json::from_str(GENERIC).unwrap();
    let get = |name: &str| {
        v["args"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["name"] == name)
            .unwrap()["default"]
            .as_f64()
            .unwrap()
    };
    (get("mrt_shade"), get("mrt_sun"))
}

fn cost_at(celsius: f64, inflation: f64) -> f64 {
    let g = OswGraph::from_binary(&tiny_binary(3, mrt_byte(celsius))).unwrap();
    cost_with(GENERIC, &edge_attrs(&g), json!({ "sun_inflation": inflation })).unwrap()
}

// ── 1. v2 compatibility ──────────────────────────────────────────────────────

#[test]
fn v2_binary_still_loads() {
    let g = OswGraph::from_binary(&tiny_binary(2, 0)).expect("v2 must still load");
    assert_eq!(g.edge_count(), 1);
}

#[test]
fn v2_edge_carries_no_mrt() {
    let g = OswGraph::from_binary(&tiny_binary(2, 0)).unwrap();
    assert!(
        !edge_attrs(&g).contains_key("mrt"),
        "a v2 edge must be unknown, not zero",
    );
}

#[test]
fn unsurveyed_edge_is_unaffected_by_the_thermal_term() {
    // The alpha criterion: routes are identical where no thermal signal exists.
    let g = OswGraph::from_binary(&tiny_binary(2, 0)).unwrap();
    let attrs = edge_attrs(&g);
    let off = cost_with(GENERIC, &attrs, json!({ "sun_inflation": 0.0 }));
    let on = cost_with(GENERIC, &attrs, json!({ "sun_inflation": BETA_MEAN_INFLATION }));
    assert_eq!(off, on, "no mrt attribute means no thermal cost");
    assert_eq!(on, Some(100.0), "and the cost is still plain length");
}

#[test]
fn mrt_zero_in_a_v3_file_is_also_unknown() {
    let g = OswGraph::from_binary(&tiny_binary(3, 0)).unwrap();
    let attrs = edge_attrs(&g);
    assert!(!attrs.contains_key("mrt"));
    assert_eq!(
        cost_with(GENERIC, &attrs, json!({ "sun_inflation": BETA_MEAN_INFLATION })),
        Some(100.0),
    );
}

// ── 2. the shade anchor is the zero point ────────────────────────────────────

#[test]
fn an_edge_in_full_shade_costs_plain_length() {
    let (shade, _sun) = anchors();
    assert!((cost_at(shade, BETA_MEAN_INFLATION) - 100.0).abs() < 0.5);
}

#[test]
fn an_edge_cooler_than_the_shade_anchor_is_not_paid_a_bonus() {
    // Clamping at zero matters: a negative term would make cool edges cheaper
    // than unsurveyed ones and pull routes toward whatever the grid happens to
    // resolve as coldest.
    let (shade, _sun) = anchors();
    assert_eq!(cost_at(shade - 10.0, BETA_MEAN_INFLATION), 100.0);
    assert_eq!(cost_at(shade - 0.5, BETA_MEAN_INFLATION), 100.0);
}

#[test]
fn a_shaded_surveyed_edge_matches_an_unsurveyed_one() {
    // This is the property that stops the router being paid to leave coverage.
    let (shade, _sun) = anchors();
    let g_unsurveyed = OswGraph::from_binary(&tiny_binary(2, 0)).unwrap();
    let unsurveyed = cost_with(
        GENERIC,
        &edge_attrs(&g_unsurveyed),
        json!({ "sun_inflation": BETA_MEAN_INFLATION }),
    )
    .unwrap();
    assert!((cost_at(shade, BETA_MEAN_INFLATION) - unsurveyed).abs() < 0.5);
}

// ── 3. the coefficient means what it says ────────────────────────────────────

#[test]
fn full_sun_costs_exactly_beta_minus_one_more() {
    // Melnikov et al: 100 m in full shade is perceived as 86 m in the sun, so
    // a metre in sun costs 1.16 metres in shade.
    let (_shade, sun) = anchors();
    let got = cost_at(sun, BETA_MEAN_INFLATION);
    assert!(
        (got - 116.0).abs() < 0.5,
        "full sun cost {got}, want 116 for beta = 1.16",
    );
}

#[test]
fn inflation_is_linear_between_the_anchors() {
    let (shade, sun) = anchors();
    let mid = (shade + sun) / 2.0;
    let got = cost_at(mid, BETA_MEAN_INFLATION);
    assert!(
        (got - 108.0).abs() < 0.6,
        "half exposure cost {got}, want 108 for a linear term",
    );
}

#[test]
fn exposure_is_clamped_above_the_sun_anchor() {
    // A cell hotter than the open-sun anchor exists (a sunlit canyon reflects
    // extra shortwave onto the body). It must not extrapolate past beta.
    let (_shade, sun) = anchors();
    let at_sun = cost_at(sun, BETA_MEAN_INFLATION);
    let beyond = cost_at(sun + 15.0, BETA_MEAN_INFLATION);
    assert!((beyond - at_sun).abs() < 0.5, "{beyond} should equal {at_sun}");
}

#[test]
fn a_heat_sensitive_coefficient_costs_more_on_the_same_edge() {
    // How the condition map expresses sensitivity: it moves the coefficient
    // within the range Melnikov actually observed, it does not add a profile.
    let (_shade, sun) = anchors();
    let mean = cost_at(sun, BETA_MEAN_INFLATION);
    let sensitive = cost_at(sun, 0.84); // Melnikov individual maximum, beta = 1.84
    assert!(sensitive > mean);
    assert!((sensitive - 184.0).abs() < 0.5, "got {sensitive}");
}

#[test]
fn zero_coefficient_reproduces_the_pre_thermal_router() {
    let (_shade, sun) = anchors();
    assert_eq!(cost_at(sun, 0.0), 100.0);
    assert_eq!(cost_at(sun + 20.0, 0.0), 100.0);
}

#[test]
fn cost_is_monotone_in_temperature() {
    let mut previous = 0.0;
    for celsius in [25.0, 33.0, 40.0, 48.0, 55.0, 62.0, 70.0] {
        let cost = cost_at(celsius, BETA_MEAN_INFLATION);
        assert!(cost >= previous, "cost fell at {celsius} C");
        previous = cost;
    }
}

#[test]
fn degenerate_anchors_do_not_produce_nan() {
    // A misconfigured profile must degrade to the plain router, not poison the
    // shortest-path tree with NaN.
    let g = OswGraph::from_binary(&tiny_binary(3, mrt_byte(55.0))).unwrap();
    let attrs = edge_attrs(&g);
    let got = cost_with(
        GENERIC,
        &attrs,
        json!({ "sun_inflation": 0.5, "mrt_shade": 40.0, "mrt_sun": 40.0 }),
    )
    .unwrap();
    assert!(got.is_finite(), "got {got}");
    assert_eq!(got, 100.0);
}

// ── 4. the three profiles must not drift ─────────────────────────────────────

fn thermal_block(profile_json: &str) -> (Vec<Value>, Vec<Value>) {
    let v: Value = serde_json::from_str(profile_json).unwrap();
    let args = v["args"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|a| {
            let n = a["name"].as_str().unwrap_or("");
            n == "sun_inflation" || n.starts_with("mrt_")
        })
        .cloned()
        .collect();
    let terms = v["cost"]["terms"].as_array().cloned().unwrap_or_default();
    (args, terms)
}

#[test]
fn every_profile_ships_the_same_thermal_block() {
    let generic = thermal_block(GENERIC);
    for (name, other) in [
        ("manual_wheelchair", thermal_block(WHEELCHAIR)),
        ("low_vision", thermal_block(LOW_VISION)),
    ] {
        assert_eq!(generic.0, other.0, "{name} thermal args drifted");
        assert_eq!(generic.1, other.1, "{name} thermal term drifted");
    }
}

#[test]
fn thermal_block_is_actually_present() {
    let (args, terms) = thermal_block(GENERIC);
    assert_eq!(args.len(), 3, "two anchors plus the coefficient");
    assert_eq!(terms.len(), 1, "one continuous term");
    assert_eq!(terms[0]["attr"], "mrt");
}

#[test]
fn the_thermal_layer_is_off_by_default() {
    // Shipping it on would change every existing route silently.
    let (_shade, sun) = anchors();
    let g = OswGraph::from_binary(&tiny_binary(3, mrt_byte(sun))).unwrap();
    let profile = Profile::from_json(GENERIC).unwrap();
    let args = profile.resolve_args(HashMap::new()).unwrap();
    assert_eq!(
        eval_cost(&profile.cost, &edge_attrs(&g), &args),
        Some(100.0),
        "sun_inflation must default to 0",
    );
}

#[test]
fn every_thermal_arg_is_documented() {
    let v: Value = serde_json::from_str(GENERIC).unwrap();
    for a in v["args"].as_array().unwrap() {
        let name = a["name"].as_str().unwrap();
        let described = a["description"].as_str().unwrap_or("");
        assert!(
            described.len() > 40,
            "arg {name} needs a real description, got {described:?}",
        );
    }
}

#[test]
fn the_coefficient_cites_its_source() {
    // The whole argument rests on these numbers not being invented. If the
    // citation disappears from the shipped data file, that claim is no longer
    // checkable by whoever reads it next.
    let v: Value = serde_json::from_str(GENERIC).unwrap();
    let described = v["args"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["name"] == "sun_inflation")
        .unwrap()["description"]
        .as_str()
        .unwrap();
    assert!(described.contains("Melnikov"), "{described}");
    assert!(described.contains("2022"), "{described}");
}
