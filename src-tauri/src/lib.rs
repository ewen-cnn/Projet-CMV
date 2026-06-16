use serde::Serialize;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::Emitter;

//
// =========================
// STRUCTURE DATA
// =========================
//

#[derive(Clone, Serialize, Debug)]
pub struct SensorData {
    pub rpm: f32,
    pub temp1: f32,
    pub temp2: f32,
    pub temp3: f32,
    pub temp_eau: f32,
    pub temp5: f32,
    pub energy: f32,
}

impl Default for SensorData {
    fn default() -> Self {
        Self {
            rpm: 0.0,
            temp1: 0.0,
            temp2: 0.0,
            temp3: 0.0,
            temp_eau: 0.0,
            temp5: 0.0,
            energy: 0.0,
        }
    }
}

//
// =========================
// STATE GLOBAL
// =========================
//

#[derive(Clone)]
pub struct SharedState {
    pub last_data: Arc<Mutex<SensorData>>,
    pub write_port: Arc<Mutex<Option<Box<dyn serialport::SerialPort>>>>,
}

const BAUD_RATE: u32 = 115200;
const PREFERRED_PORTS: [&str; 4] = [
    "/dev/ttyACM0",
    "/dev/ttyACM1",
    "/dev/ttyUSB0",
    "/dev/ttyUSB1",
];

//
// =========================
// COMMANDES TAURI
// =========================
//

#[tauri::command]
fn get_sensor_data(state: tauri::State<'_, SharedState>) -> Result<SensorData, String> {
    let data = state
        .last_data
        .lock()
        .map_err(|_| "Impossible de lire last_data".to_string())?;

    Ok(data.clone())
}

#[tauri::command]
fn set_pwm(duty: f32, state: tauri::State<'_, SharedState>) -> Result<(), String> {
    if duty < 0.0 || duty > 100.0 {
        return Err("Duty-cycle invalide. Valeur attendue entre 0 et 100.".into());
    }

    let command = format!("Duty : {:.1}\n", duty);

    let mut port_guard = state
        .write_port
        .lock()
        .map_err(|_| "Impossible de verrouiller le port série".to_string())?;

    match port_guard.as_mut() {
        Some(port) => {
            port.write_all(command.as_bytes())
                .map_err(|e| format!("Erreur écriture UART: {}", e))?;

            port.flush()
                .map_err(|e| format!("Erreur flush UART: {}", e))?;

            println!("✅ Commande envoyée à la STM32 : {}", command.trim());
        }

        None => {
            return Err(format!(
                "Aucun port série STM32 ouvert : commande non envoyée ({})",
                command.trim()
            ));
        }
    }

    Ok(())
}

//
// =========================
// UART LISTENER
// =========================
//

fn start_uart_listener(
    app: tauri::AppHandle,
    state: SharedState,
    read_port: Box<dyn serialport::SerialPort>,
) {
    thread::spawn(move || {
        let mut reader = BufReader::new(read_port);

        loop {
            let mut line = String::new();

            match reader.read_line(&mut line) {
                Ok(n) if n > 0 => {
                    let clean_line = clean_serial_line(&line);

                    if clean_line.is_empty() {
                        continue;
                    }

                    if log_stm32_status(&clean_line) {
                        continue;
                    }

                    if let Some(data) = parse_line(&clean_line) {
                        println!("📥 Données STM32 : {}", clean_line);

                        // 1. Stockage dernière donnée réelle
                        if let Ok(mut last_data) = state.last_data.lock() {
                            *last_data = data.clone();
                        }

                        // 2. Envoi event temps réel au frontend
                        let _ = app.emit("sensor-data", data);
                    }
                }

                Ok(_) => {
                    // rien reçu
                }

                Err(_) => {
                    // timeout UART, bruit ou lecture vide
                }
            }
        }
    });
}

//
// =========================
// MODE SIMULATION
// =========================
//

fn start_simulation_listener(app: tauri::AppHandle, state: SharedState) {
    thread::spawn(move || {
        let mut rpm = 800.0;

        loop {
            rpm += 25.0;

            if rpm > 1600.0 {
                rpm = 800.0;
            }

            let data = SensorData {
                rpm,
                temp1: 22.5,
                temp2: 30.0,
                temp3: 25.0,
                temp_eau: 35.2,
                temp5: 40.1,
                energy: 150.0,
            };

            if let Ok(mut last_data) = state.last_data.lock() {
                *last_data = data.clone();
            }

            let _ = app.emit("sensor-data", data);

            thread::sleep(Duration::from_millis(1000));
        }
    });
}

//
// =========================
// PARSING
// =========================
//

fn clean_serial_line(line: &str) -> String {
    line.trim()
        .trim_matches('\0')
        .replace('\0', "")
        .trim()
        .to_string()
}

fn log_stm32_status(line: &str) -> bool {
    if let Some(duty) = extract_pwm_ack_duty(line) {
        println!(
            "✅ STM32 : commande PWM bien reçue, duty appliqué = {}%",
            duty
        );
        return true;
    }

    if let Some(error) = line.strip_prefix("ERR;") {
        eprintln!("⚠️ STM32 : erreur commande UART ({})", error);
        return true;
    }

    false
}

fn extract_pwm_ack_duty(line: &str) -> Option<&str> {
    if let Some(payload) = line.strip_prefix("ACK;PWM;") {
        return payload.split(';').next().filter(|duty| !duty.is_empty());
    }

    if let Some(payload) = line.strip_prefix("ACK PWM DUTY=") {
        return payload.trim().split_whitespace().next();
    }

    if let Some(payload) = line.strip_prefix("ACK PWM DUTY =") {
        return payload.trim().split_whitespace().next();
    }

    None
}

fn parse_line(line: &str) -> Option<SensorData> {
    let clean_line = clean_serial_line(line);

    if clean_line.is_empty() || clean_line.starts_with("ACK;") || clean_line.starts_with("ERR;") {
        return None;
    }

    let parts: Vec<&str> = clean_line.split('|').collect();

    if parts.len() < 3 {
        eprintln!("❌ Trame STM32 invalide : {}", clean_line);
        return None;
    }

    let data = SensorData {
        rpm: parts[0].trim().parse().ok()?,
        temp1: parts[1].trim().parse().ok()?,
        temp2: parts[2].trim().parse().ok()?,
        temp3: 0.0,
        temp_eau: 0.0,
        temp5: 0.0,
        energy: 0.0,
    };

    if let Some(duty) = parts.get(3) {
        println!("ℹ️ Duty STM32 courant : {}%", duty.trim());
    }

    Some(data)
}

fn find_stm32_port() -> String {
    for port in PREFERRED_PORTS {
        if Path::new(port).exists() {
            return port.to_string();
        }
    }

    if let Ok(ports) = serialport::available_ports() {
        if let Some(port) = ports.into_iter().find(|port| {
            port.port_name.contains("ttyACM")
                || port.port_name.contains("ttyUSB")
                || port.port_name.contains("STM")
        }) {
            return port.port_name;
        }
    }

    PREFERRED_PORTS[0].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_stm32_pipe_frame() {
        let data = parse_line("12|24.50|33.00|42\r\n").unwrap();

        assert_eq!(data.rpm, 12.0);
        assert_eq!(data.temp1, 24.5);
        assert_eq!(data.temp2, 33.0);
    }

    #[test]
    fn ignores_ack_frames() {
        assert!(parse_line("ACK;PWM;42;COMMANDE_RECUE").is_none());
        assert_eq!(
            extract_pwm_ack_duty("ACK;PWM;42;COMMANDE_RECUE"),
            Some("42")
        );
    }

    #[test]
    fn cleans_null_bytes() {
        assert_eq!(
            clean_serial_line("12|24.50|33.00|42\r\n\0\0\0"),
            "12|24.50|33.00|42"
        );
    }
}

//
// =========================
// TAURI ENTRY POINT
// =========================
//

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let shared_state = SharedState {
        last_data: Arc::new(Mutex::new(SensorData::default())),
        write_port: Arc::new(Mutex::new(None)),
    };

    tauri::Builder::default()
        .manage(shared_state.clone())
        .setup(move |app| {
            let handle = app.handle().clone();

            let port_name = find_stm32_port();

            let serial_result = serialport::new(&port_name, BAUD_RATE)
                .timeout(Duration::from_millis(100))
                .open();

            match serial_result {
                Ok(read_port) => {
                    println!("✅ UART connecté sur {}", port_name);

                    match read_port.try_clone() {
                        Ok(write_port) => {
                            if let Ok(mut guard) = shared_state.write_port.lock() {
                                *guard = Some(write_port);
                            }
                        }

                        Err(e) => {
                            eprintln!("⚠️ Impossible de cloner le port série : {}", e);
                        }
                    }

                    start_uart_listener(handle, shared_state.clone(), read_port);
                }

                Err(e) => {
                    eprintln!(
                        "⚠️ Aucune STM32 détectée sur {}. Mode simulation actif. Erreur : {}",
                        port_name, e
                    );

                    start_simulation_listener(handle, shared_state.clone());
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_sensor_data, set_pwm])
        .run(tauri::generate_context!())
        .expect("error while running tauri application")
}
