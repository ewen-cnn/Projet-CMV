// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::thread;
use std::time::Duration;
use tauri::Emitter;
use std::io::Write;
use std::sync::Mutex;

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


//
// =========================
// COMMANDES TAURI
// =========================
//

#[tauri::command]
fn get_sensor_data() -> SensorData {
    SensorData {
        rpm: 1200.0,
        temp1: 22.5,
        temp2: 30.0,
        temp3: 25.0,
        temp_eau: 35.2,
        temp5: 40.1,
        energy: 150.0,
    }
}

#[tauri::command]
fn inject_current(voltage: f32) {
    println!("⚡ Injection courant : {} V", voltage);

    // 👉 ici tu branches ton driver (CAN / UART / PWM STM32)
}


//
// =========================
// UART LISTENER
// =========================
//

fn start_uart_listener(app: tauri::AppHandle) {
    thread::spawn(move || {
        let port_name = "/dev/ttyUSB0"; // ⚠️ adapte si besoin
        let baud_rate = 115200;

        let port = serialport::new(port_name, baud_rate)
            .timeout(Duration::from_millis(100))
            .open();

        let port = match port {
            Ok(p) => {
                println!("✅ UART connecté sur {}", port_name);
                p
            }
            Err(e) => {
                eprintln!("❌ Erreur ouverture UART: {}", e);
                return;
            }
        };

        let mut reader = BufReader::new(port);

        loop {
            let mut line = String::new();

            match reader.read_line(&mut line) {
                Ok(n) if n > 0 => {
                    if let Some(data) = parse_line(&line) {
                        // Envoi au frontend
                        let _ = app.emit("sensor-data", data);
                    }
                }
                Ok(_) => {
                    // rien reçu
                }
                Err(_) => {
                    // timeout / bruit → ignorer
                }
            }
        }
    });
}

struct SerialState {
    pub port: Mutex<Box<dyn serialport::SerialPort>>,
}

//
// =========================
// UART READER
// =========================
//

#[tauri::command]
fn set_pwm(duty: f32, state: tauri::State<'_, SerialState>) -> Result<(), String> {
    if duty < 0.0 || duty > 100.0 {
        return Err("Duty-cycle invalide. Valeur attendue entre 0 et 100.".into());
    }

    let command = format!("PWM;{:.1}\n", duty);

    let mut port = state
        .port
        .lock()
        .map_err(|_| "Impossible de verrouiller le port série".to_string())?;

    port.write_all(command.as_bytes())
        .map_err(|e| format!("Erreur écriture UART: {}", e))?;

    port.flush()
        .map_err(|e| format!("Erreur flush UART: {}", e))?;

    println!("Commande envoyée à la STM32 : {}", command.trim());

    Ok(())
}

//
// =========================
// PARSING
// =========================
//
fn parse_line(line: &str) -> Option<SensorData> {
    let parts: Vec<&str> = line.trim().split(';').collect();

    if parts.len() != 7 {
        return None;
    }

    Some(SensorData {
        rpm: parts[0].parse().ok()?,
        temp1: parts[1].parse().ok()?,
        temp2: parts[2].parse().ok()?,
        temp3: parts[3].parse().ok()?,
        temp_eau: parts[4].parse().ok()?,
        temp5: parts[5].parse().ok()?,
        energy: parts[6].parse().ok()?,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/*
pub fn run() {
/*let port = serialport::new("/dev/ttyACM0", 115200)
        .timeout(std::time::Duration::from_millis(100))
        .open()
        .expect("Impossible d'ouvrir le port série");
*/
    tauri::Builder::default()
        .manage(SerialState {
            port: std::sync::Mutex::new(port),
        })
        .setup(|app| {
            let handle = app.handle().clone();
            start_uart_listener(handle);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            inject_current,
            get_sensor_data,
            set_pwm
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
*/
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Lancement du thread UART
            let handle = app.handle().clone();
            start_uart_listener(handle);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            inject_current, 
            get_sensor_data,
            set_pwm
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}