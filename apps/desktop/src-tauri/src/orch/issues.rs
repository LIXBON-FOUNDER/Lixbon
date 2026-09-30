//! Issues de Lixbon Team para los agentes: `lxo issue ver|comentar|mover|vincular`.
//! Habla con el gateway con la misma cuenta que el IDE (la llave del almacén
//! cifrado o, fuera de Windows, la de los ajustes), así que un agente solo ve
//! las issues de los equipos de quien lo lanzó.

use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tauri_plugin_http::reqwest::{self, Method};

struct Sesion {
    servidor: String,
    llave: String,
}

fn sesion(app: &AppHandle) -> Result<Sesion, String> {
    let ruta = app.path().app_data_dir().map_err(|e| e.to_string())?.join("lixbon.settings.json");
    let ajustes: Value = std::fs::read_to_string(&ruta)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Null);
    let servidor = ajustes
        .get("serverUrl")
        .and_then(Value::as_str)
        .unwrap_or("https://lixbon.com")
        .trim_end_matches('/')
        .to_string();
    let llave = crate::secret_get("apiKey".into())
        .ok()
        .flatten()
        .or_else(|| ajustes.get("apiKey").and_then(Value::as_str).map(String::from))
        .filter(|k| !k.is_empty())
        .ok_or("No hay sesión de Lixbon: inicia sesión en el IDE")?;
    Ok(Sesion { servidor, llave })
}

fn pedir(s: &Sesion, metodo: Method, ruta: &str, cuerpo: Option<Value>) -> Result<Value, String> {
    let url = format!("{}{}", s.servidor, ruta);
    let llave = s.llave.clone();
    tauri::async_runtime::block_on(async move {
        let mut req = reqwest::Client::new()
            .request(metodo, url)
            .header("Authorization", format!("Bearer {llave}"))
            .timeout(Duration::from_secs(20));
        if let Some(c) = cuerpo {
            req = req.header("Content-Type", "application/json").body(c.to_string());
        }
        let res = req.send().await.map_err(|e| format!("No se pudo contactar con Lixbon: {e}"))?;
        let estado = res.status();
        let texto = res.text().await.unwrap_or_default();
        let datos: Value = serde_json::from_str(&texto).unwrap_or(Value::Null);
        if !estado.is_success() {
            return Err(datos
                .get("detail")
                .and_then(Value::as_str)
                .map(String::from)
                .unwrap_or_else(|| format!("Lixbon respondió {estado}")));
        }
        Ok(datos)
    })
}

/// «LXB-12» → el detalle entero de la issue.
fn buscar(s: &Sesion, clave: &str) -> Result<Value, String> {
    let clave = clave.trim();
    let valida = clave.split_once('-').is_some_and(|(p, n)| {
        !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric()) && !n.is_empty() && n.chars().all(|c| c.is_ascii_digit())
    });
    if !valida {
        return Err(format!("«{clave}» no es una clave de issue (ejemplo: LXB-12)"));
    }
    let r = pedir(s, Method::GET, &format!("/api/team/issues/buscar?clave={clave}"), None)?;
    let id = r["id"].as_str().ok_or("Respuesta inesperada del gateway")?;
    pedir(s, Method::GET, &format!("/api/team/issues/{id}"), None)
}

fn plano(t: &str) -> String {
    t.to_lowercase()
        .chars()
        .map(|c| match c {
            'á' => 'a',
            'é' => 'e',
            'í' => 'i',
            'ó' => 'o',
            'ú' | 'ü' => 'u',
            _ => c,
        })
        .filter(|c| c.is_alphanumeric())
        .collect()
}

/// El estado pedido por nombre («En revisión») o por tipo («revision», «hecho»).
fn estado_de(issue: &Value, pedido: &str) -> Result<String, String> {
    let quiero = plano(pedido);
    let estados = issue["estados"].as_array().cloned().unwrap_or_default();
    estados
        .iter()
        .find(|e| plano(e["nombre"].as_str().unwrap_or("")) == quiero)
        .or_else(|| estados.iter().find(|e| plano(e["tipo"].as_str().unwrap_or("")) == quiero))
        .and_then(|e| e["id"].as_str().map(String::from))
        .ok_or_else(|| {
            let nombres: Vec<&str> = estados.iter().filter_map(|e| e["nombre"].as_str()).collect();
            format!("No hay un estado «{pedido}». Los de este equipo: {}", nombres.join(", "))
        })
}

/// `accion`: ver | comentar | mover | vincular. `rol` es el del agente que
/// llama (si es una hija con rol): su comentario sale como informe de agente.
pub fn ejecutar(app: &AppHandle, args: &Value, rol: Option<String>) -> Result<Value, String> {
    let s = sesion(app)?;
    let accion = args["accion"].as_str().unwrap_or("ver");
    let clave = args["clave"].as_str().unwrap_or("");
    let issue = buscar(&s, clave)?;
    let id = issue["id"].as_str().unwrap_or("").to_string();
    match accion {
        "ver" => Ok(json!({ "accion": "ver", "issue": issue })),
        "comentar" => {
            let texto = args["texto"].as_str().unwrap_or("").trim();
            if texto.is_empty() {
                return Err("Falta el comentario: --texto \"...\" o --texto - con el texto por stdin".into());
            }
            let de_agente = rol.filter(|r| ["explorador", "implementador", "revisor", "escalado"].contains(&r.as_str()));
            pedir(&s, Method::POST, &format!("/api/team/issues/{id}/comments"), Some(json!({ "texto": texto, "de_agente": de_agente })))?;
            Ok(json!({ "accion": "comentar", "clave": issue["clave"] }))
        }
        "mover" => {
            let estado = estado_de(&issue, args["estado"].as_str().unwrap_or(""))?;
            let r = pedir(&s, Method::PATCH, &format!("/api/team/issues/{id}"), Some(json!({ "estado_id": estado })))?;
            let nombre = issue["estados"]
                .as_array()
                .and_then(|l| l.iter().find(|e| e["id"] == r["estado_id"]))
                .and_then(|e| e["nombre"].as_str())
                .unwrap_or("")
                .to_string();
            Ok(json!({ "accion": "mover", "clave": issue["clave"], "estado": nombre }))
        }
        "vincular" => {
            let tipo = args["tipo"].as_str().unwrap_or("");
            let referencia = args["ref"].as_str().unwrap_or("");
            if !["rama", "pr", "commit"].contains(&tipo) || referencia.is_empty() {
                return Err("Uso: lxo issue vincular <CLAVE> --rama <rama> | --pr <#n> [--url https://…] | --commit <sha>".into());
            }
            let mut cuerpo = json!({ "tipo": tipo, "ref": referencia });
            if let Some(url) = args["url"].as_str().filter(|u| !u.is_empty()) {
                cuerpo["url"] = json!(url);
            }
            if tipo == "pr" {
                cuerpo["estado"] = json!(args["estado"].as_str().unwrap_or("abierto"));
            }
            pedir(&s, Method::POST, &format!("/api/team/issues/{id}/links"), Some(cuerpo))?;
            Ok(json!({ "accion": "vincular", "clave": issue["clave"], "tipo": tipo, "ref": referencia }))
        }
        otra => Err(format!("Acción desconocida: {otra}. Usa ver, comentar, mover o vincular.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn estado_por_nombre_o_tipo_sin_tildes() {
        let issue = json!({ "estados": [
            { "id": "a", "nombre": "En curso", "tipo": "en_curso" },
            { "id": "b", "nombre": "En revisión", "tipo": "revision" },
            { "id": "c", "nombre": "Hecho", "tipo": "hecho" },
        ]});
        assert_eq!(estado_de(&issue, "en revision").unwrap(), "b");
        assert_eq!(estado_de(&issue, "En revisión").unwrap(), "b");
        assert_eq!(estado_de(&issue, "hecho").unwrap(), "c");
        assert_eq!(estado_de(&issue, "en_curso").unwrap(), "a");
        assert!(estado_de(&issue, "bloqueada").unwrap_err().contains("En curso, En revisión, Hecho"));
    }
}
