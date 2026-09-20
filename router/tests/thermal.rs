//! Thermal cost regression tests.
//!
//! Three properties matter and each is asserted here:
//!
//!   1. A v2 binary still loads, and carries no `mrt` attribute. Routing over
//!      it with `heat_aware=true` must cost exactly what `heat_aware=false`
//!      costs, because an unsurveyed edge is unknown, not cool.
//!   2. A v3 binary exposes `mrt`, and the bands compound as documented.
//!   3. The thermal block is identical across all three shipped profiles.
//!      They are separate JSON files with no include mechanism, so drift is
//!      the obvious failure mode.

use std::collections::HashMap;

use serde_json::{json, Value};
use unweaver_wasm::cost::eval_cost;
use unweaver_wasm::graph::OswGraph;
use unweaver_wasm::profile::Profile;

const GENERIC: &str = include_str!("../examples/profile-generic_pedestrian.json");
const WHEELCHAIR: &str = include_str!("../examples/profile-manual_wheelchair.json");
const LOW_VISION: &str = include_str!("../examples/profile-low_vision.json");

/// Build a minimal OSWB binary in memory: two nodes, one edge between them.
/// `mrt` is ignored when `version` is 2.
fn tiny_binary(version: u8, mrt: u8) -> Vec<u8> {
    let mut b = Vec::new();
    b.extend_from_slice(b"OSWB");
    b.push(version);
    b.extend_from_slice(&[0, 0, 0]); // pad
    b.extend_from_slice(&2u32.to_le_bytes()); // node_count
    b.extend_from_slice(&1u32.to_le_bytes()); // edge_count

    for (lon, lat) in [(-73.91f32, 40.66f32), (-73.909f32, 40.66f32)] {
        b.extend_from_slice(&lon.to_le_bytes());
        b.extend_from_slice(&lat.to_le_bytes());
        b.push(0); // attrs
        b.push(0); // pad
    }

    b.extend_from_slice(&0u32.to_le_bytes()); // u_idx
    b.extend_from_slice(&1u32.to_le_bytes()); // v_idx
    b.extend_from_slice(&100.0f32.to_le_bytes()); // length
    b.extend_from_slice(&0i16.to_le_bytes()); // incline
    b.push(0); // footway = sidewalk
    b.push(1); // surface = asphalt
    b.push(0); // flags
    b.push(0); // width unknown
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
fn unsurveyed_edge_is_unaffected_by_heat_aware() {
    // The alpha criterion: routes are identical where no thermal signal exists.
    let g = OswGraph::from_binary(&tiny_binary(2, 0)).unwrap();
    let attrs = edge_attrs(&g);
    let cold = cost_with(GENERIC, &attrs, json!({"heat_aware": false}));
    let hot = cost_with(GENERIC, &attrs, json!({"heat_aware": true}));
    assert_eq!(cold, hot, "no mrt attribute means no thermal penalty");
    assert_eq!(hot, Some(100.0), "and the cost is still plain length");
}

#[test]
fn mrt_zero_in_a_v3_file_is_also_unknown() {
    // 0 is the not-surveyed sentinel, not 20 C. A v3 file with gaps must behave
    // exactly like a v2 file on those edges.
    let g = OswGraph::from_binary(&tiny_binary(3, 0)).unwrap();
    let attrs = edge_attrs(&g);
    assert!(!attrs.contains_key("mrt"));
    assert_eq!(
        cost_with(GENERIC, &attrs, json!({"heat_aware": true})),
        Some(100.0),
    );
}

// ── 2. v3 decoding and band arithmetic ───────────────────────────────────────

/// Encode a temperature the way the exporter does, so the test exercises the
/// real round trip rather than a hand-picked byte.
fn mrt_byte(celsius: f64) -> u8 {
    (((celsius - 20.0) / 0.5).round() as i64).clamp(1, 255) as u8
}

#[test]
fn v3_round_trips_temperature_within_quantisation() {
    for c in [25.0, 33.5, 41.0, 52.25, 66.0] {
        let g = OswGraph::from_binary(&tiny_binary(3, mrt_byte(c))).unwrap();
        let got = edge_attrs(&g).get("mrt").unwrap().as_f64().unwrap();
        assert!(
            (got - c).abs() <= 0.25,
            "{c} C round-tripped to {got} C, outside the 0.25 C quantisation error",
        );
    }
}

#[test]
fn bands_compound_as_documented() {
    // Thresholds: warm 35, hot 42, severe 50, extreme 58.
    // Multipliers:      1.15,    1.30,       1.50,        1.75.
    let cases: [(f64, f64); 5] = [
        (30.0, 1.0),                            // below every threshold
        (36.0, 1.15),                           // warm
        (45.0, 1.15 * 1.30),                    // warm + hot
        (52.0, 1.15 * 1.30 * 1.50),             // + severe
        (62.0, 1.15 * 1.30 * 1.50 * 1.75),      // + extreme
    ];
    for (celsius, factor) in cases {
        let g = OswGraph::from_binary(&tiny_binary(3, mrt_byte(celsius))).unwrap();
        let attrs = edge_attrs(&g);
        let got = cost_with(GENERIC, &attrs, json!({"heat_aware": true})).unwrap();
        let want = 100.0 * factor;
        assert!(
            (got - want).abs() < 1e-9,
            "{celsius} C: got {got}, want {want}",
        );
    }
}

#[test]
fn heat_aware_off_ignores_a_surveyed_hot_edge() {
    let g = OswGraph::from_binary(&tiny_binary(3, mrt_byte(65.0))).unwrap();
    let attrs = edge_attrs(&g);
    assert_eq!(
        cost_with(GENERIC, &attrs, json!({"heat_aware": false})),
        Some(100.0),
        "the thermal layer must be opt-in per query",
    );
}

#[test]
fn penalty_is_monotone_in_temperature() {
    let g_cool = OswGraph::from_binary(&tiny_binary(3, mrt_byte(30.0))).unwrap();
    let mut previous = cost_with(GENERIC, &edge_attrs(&g_cool), json!({"heat_aware": true})).unwrap();
    for celsius in [36.0, 43.0, 51.0, 59.0, 70.0] {
        let g = OswGraph::from_binary(&tiny_binary(3, mrt_byte(celsius))).unwrap();
        let cost = cost_with(GENERIC, &edge_attrs(&g), json!({"heat_aware": true})).unwrap();
        assert!(cost >= previous, "cost fell going from cooler to {celsius} C");
        previous = cost;
    }
}

#[test]
fn lowering_the_thresholds_makes_a_warm_edge_expensive() {
    // This is how the condition map expresses heat sensitivity: it moves the
    // thresholds, it does not add a profile.
    let g = OswGraph::from_binary(&tiny_binary(3, mrt_byte(33.0))).unwrap();
    let attrs = edge_attrs(&g);
    let healthy = cost_with(GENERIC, &attrs, json!({"heat_aware": true})).unwrap();
    let sensitive = cost_with(
        GENERIC,
        &attrs,
        json!({"heat_aware": true, "mrt_warm": 28.0, "mrt_hot": 32.0}),
    )
    .unwrap();
    assert_eq!(healthy, 100.0, "33 C is below the default comfort threshold");
    assert!(
        sensitive > healthy,
        "a heat-sensitive profile must pay more on the same edge",
    );
}

// ── 3. The three profiles must not drift ─────────────────────────────────────

fn thermal_block(profile_json: &str) -> (Vec<Value>, Vec<Value>) {
    let v: Value = serde_json::from_str(profile_json).unwrap();
    let args = v["args"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|a| {
            let n = a["name"].as_str().unwrap_or("");
            n == "heat_aware" || n.starts_with("mrt_")
        })
        .cloned()
        .collect();
    let multipliers = v["cost"]["multipliers"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m.to_string().contains("heat_aware"))
        .cloned()
        .collect();
    (args, multipliers)
}

#[test]
fn every_profile_ships_the_same_thermal_block() {
    let generic = thermal_block(GENERIC);
    for (name, other) in [
        ("manual_wheelchair", thermal_block(WHEELCHAIR)),
        ("low_vision", thermal_block(LOW_VISION)),
    ] {
        assert_eq!(generic.0, other.0, "{name} thermal args drifted");
        assert_eq!(generic.1, other.1, "{name} thermal multipliers drifted");
    }
}

#[test]
fn thermal_block_is_actually_present() {
    let (args, multipliers) = thermal_block(GENERIC);
    assert_eq!(args.len(), 5, "heat_aware plus four thresholds");
    assert_eq!(multipliers.len(), 4, "one multiplier per band");
}

#[test]
fn every_thermal_arg_is_documented() {
    // The condition map is meant to be readable by a clinician who never opens
    // the code. An undocumented knob defeats that.
    let v: Value = serde_json::from_str(GENERIC).unwrap();
    for a in v["args"].as_array().unwrap() {
        let name = a["name"].as_str().unwrap();
        let described = a["description"].as_str().unwrap_or("");
        assert!(
            described.len() > 20,
            "arg {name} needs a real description, got {described:?}",
        );
    }
}
