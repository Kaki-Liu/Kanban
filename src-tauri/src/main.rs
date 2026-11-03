#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod desktop;
mod exchange;
mod store;
mod validation;

fn main() {
    desktop::run();
}
