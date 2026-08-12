//! Closed Studio Harness Protocol types and the native Harness boundary.
//!
//! Live Harness authority remains unavailable until a verified activation receipt is installed.

pub mod activation;
pub mod broker;
pub mod compatibility;
#[rustfmt::skip]
pub mod generated;
pub mod projections;
pub mod recovery;
pub mod sidecar;
