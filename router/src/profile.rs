//! Profile JSON parsing.
//!
//! A profile declares:
//!   - id: unique name used in API calls
//!   - args: runtime parameters with name, type, and optional default
//!   - cost: a rule-tree that evaluates to f64 cost (or None = impassable)
//!
//! This mirrors Unweaver's profile-*.json shape, replacing the Python cost
//! function file reference with a self-contained rule-tree (see DECISIONS.md §B).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

/// Edge attributes: a map from attribute name to JSON value.
/// This is what the cost rule-tree evaluates against.
pub type EdgeAttrs = HashMap<String, Value>;

/// Runtime arguments supplied by the caller for one routing query.
pub type RuntimeArgs = HashMap<String, Value>;

#[derive(Debug, Error)]
pub enum ProfileError {
    #[error("JSON parse error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("unknown arg type '{0}' for arg '{1}'")]
    UnknownArgType(String, String),
    #[error("required arg '{0}' missing from request")]
    MissingArg(String),
    #[error("arg '{0}' has wrong type")]
    ArgTypeMismatch(String),
}

/// Declared type for a profile argument.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ArgType {
    Float,
    Int,
    Bool,
    String,
}

/// A declared runtime argument for a profile.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ArgDecl {
    pub name: String,
    #[serde(rename = "type")]
    pub arg_type: ArgType,
    pub default: Option<Value>,
}

/// A single condition in the rule tree.
/// Conditions are evaluated against edge attributes and/or runtime args.
///
/// Leaf comparisons:
///   {"attr": "incline", "op": "gt", "param": "uphill_max"}  . Attr vs runtime arg
///   {"attr": "incline", "op": "gt", "value": 0.08}          . Attr vs literal
///   {"attr": "footway", "op": "eq", "value": "crossing"}
///   {"attr": "surface", "op": "in", "value": ["gravel","dirt"]}
///   {"param": "avoid_curbs", "op": "eq", "value": true}     . Runtime arg vs literal
///
/// Compound:
///   {"all": [...conditions...]}   . All must be true (AND)
///   {"any": [...conditions...]}   . Any must be true (OR)
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(untagged)]
pub enum Condition {
    All { all: Vec<Condition> },
    Any { any: Vec<Condition> },
    AttrVsParam {
        attr: String,
        op: CompOp,
        param: String,
    },
    AttrVsValue {
        attr: String,
        op: CompOp,
        value: Value,
    },
    ParamVsValue {
        param: String,
        op: CompOp,
        value: Value,
    },
}

/// Comparison operators.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CompOp {
    Eq,
    Ne,
    Gt,
    Gte,
    Lt,
    Lte,
    In,
    NotIn,
}

/// A conditional cost multiplier: if condition holds, multiply base cost by factor.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Multiplier {
    #[serde(rename = "if")]
    pub condition: Condition,
    pub multiply: f64,
}

/// A continuous cost term: a distance-inflating coefficient on exposure.
///
/// WHY THIS SHAPE, AND WHERE THE NUMBERS COME FROM
///
/// Melnikov et al. (2022), "Behavioural thermal regulation explains pedestrian
/// path choices in hot urban environments", Scientific Reports 12:2441,
/// estimate pedestrian route choice in heat from 408 observed path choices as
///
/// ```text
/// c = beta * a_sun + a_shade
/// ```
///
/// where a_sun and a_shade are metres walked in sun and in shade, and beta is
/// a distance-inflating coefficient on the sunlit part. Their population mean
/// is beta = 1.16: "100 m walked under full shade is perceived as equal to
/// 86 m under the sun". Individual estimates reach 1.84.
///
/// This term generalises that binary sun-or-shade split to a continuous
/// exposure field, by interpolating between a shade anchor and a sun anchor:
///
/// ```text
/// cost *= 1 + coefficient * clamp((attr - from) / (to - from), 0, 1)
/// ```
///
/// with `coefficient` = beta - 1. `from` is the attribute value of full shade
/// and `to` that of full sun, both at the reference meteorology.
///
/// TWO PROPERTIES THIS SHAPE HAS THAT A BAND LADDER DOES NOT
///
/// It is continuous, so the router does not flip between routes on a rounding
/// error at a band edge.
///
/// It charges nothing at the shade anchor. That matters more than it looks: an
/// edge outside any surveyed neighbourhood has no attribute at all and is
/// charged nothing, so anchoring the zero at full shade makes an unsurveyed
/// edge cost the same as a fully shaded one rather than less than every
/// surveyed edge. Anchoring instead at an absolute comfort threshold would
/// charge every surveyed edge and pay the router to leave coverage.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Term {
    #[serde(default)]
    pub description: Option<String>,
    /// Edge attribute to interpolate on. An absent attribute contributes nothing.
    pub attr: String,
    /// Runtime arg naming the attribute value of full shade.
    pub from: String,
    /// Runtime arg naming the attribute value of full sun.
    pub to: String,
    /// Runtime arg naming beta - 1, the inflation applied at full exposure.
    pub coefficient: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CostRules {
    /// Any true condition makes the edge impassable (cost = None).
    #[serde(default)]
    pub impassable_if: Vec<Condition>,
    /// Edge attribute to use as the base cost (usually "length").
    #[serde(default = "default_base")]
    pub base: String,
    /// Optional multipliers applied sequentially to the base cost.
    #[serde(default)]
    pub multipliers: Vec<Multiplier>,
    /// Optional continuous terms, applied after the multipliers.
    #[serde(default)]
    pub terms: Vec<Term>,
}

fn default_base() -> String {
    "length".to_owned()
}

/// A parsed, validated profile.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Profile {
    pub id: String,
    #[serde(default)]
    pub args: Vec<ArgDecl>,
    pub cost: CostRules,
}

impl Profile {
    pub fn from_json(json: &str) -> Result<Self, ProfileError> {
        Ok(serde_json::from_str(json)?)
    }

    /// Validate and coerce runtime args against declared arg types.
    /// Missing args with defaults are filled in. Missing required args error.
    pub fn resolve_args(&self, mut supplied: RuntimeArgs) -> Result<RuntimeArgs, ProfileError> {
        for decl in &self.args {
            if let Some(val) = supplied.get(&decl.name) {
                // Coerce / validate type
                coerce_value(val, &decl.arg_type, &decl.name)?;
            } else if let Some(default) = &decl.default {
                supplied.insert(decl.name.clone(), default.clone());
            } else {
                return Err(ProfileError::MissingArg(decl.name.clone()));
            }
        }
        Ok(supplied)
    }
}

fn coerce_value(val: &Value, t: &ArgType, name: &str) -> Result<(), ProfileError> {
    match t {
        ArgType::Float | ArgType::Int => {
            if val.as_f64().is_none() {
                return Err(ProfileError::ArgTypeMismatch(name.to_owned()));
            }
        }
        ArgType::Bool => {
            if val.as_bool().is_none() {
                return Err(ProfileError::ArgTypeMismatch(name.to_owned()));
            }
        }
        ArgType::String => {
            if val.as_str().is_none() {
                return Err(ProfileError::ArgTypeMismatch(name.to_owned()));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const WHEELCHAIR_JSON: &str = include_str!("../examples/profile-manual_wheelchair.json");

    #[test]
    fn parse_wheelchair_profile() {
        let p = Profile::from_json(WHEELCHAIR_JSON).unwrap();
        assert_eq!(p.id, "manual_wheelchair");
        assert!(!p.args.is_empty());
        assert!(!p.cost.impassable_if.is_empty());
    }

    #[test]
    fn resolve_args_uses_defaults() {
        let p = Profile::from_json(WHEELCHAIR_JSON).unwrap();
        let resolved = p.resolve_args(HashMap::new()).unwrap();
        assert!(resolved.contains_key("uphill_max"));
    }
}
