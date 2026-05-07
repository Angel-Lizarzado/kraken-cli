import paramiko
from scp import SCPClient
import os
import time
import re
import tarfile
from datetime import datetime

# --- CONFIGURACIÓN Y LOGS ---
TIMEOUT_SSH = 3600
LOG_FILE = f"migracion_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log"

def log(msg, color="RESET"):
    timestamp = datetime.now().strftime("%H:%M:%S")
    formatted_msg = f"{timestamp} | {msg}"
    
    colors = {
        "RED": "\033[91m", "GREEN": "\033[92m", "YELLOW": "\033[93m",
        "BLUE": "\033[94m", "MAGENTA": "\033[95m", "CYAN": "\033[96m",
        "RESET": "\033[0m", "GRAY": "\033[90m"
    }
    print(f"{colors.get(color, '')}{formatted_msg}{colors['RESET']}", flush=True)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(formatted_msg + "\n")

# --- LECTURA DE ARCHIVOS LOCALES ---
def leer_credenciales(ruta="servidor.txt"):
    if not os.path.exists(ruta):
        log(f"[FATAL] No se encontró {ruta}. Crea el archivo con ip, puerto, usuario y clave.", "RED")
        exit(1)
    
    creds = {}
    with open(ruta, "r", encoding="utf-8") as f:
        for linea in f:
            if "=" in linea or ":" in linea:
                # Soporta tanto "ip=123" como "ip: 123" o saltos de línea debajo
                separador = "=" if "=" in linea else ":"
                clave, valor = linea.split(separador, 1)
                creds[clave.strip().lower()] = valor.strip()
    return creds

def leer_dominios(ruta="dominios.txt"):
    if not os.path.exists(ruta):
        log(f"[FATAL] No se encontró {ruta}.", "RED")
        exit(1)
    with open(ruta, "r", encoding="utf-8") as f:
        return [line.strip() for line in f if line.strip() and not line.strip().startswith("#")]

# --- WRAPPER PARAMIKO ---
def run_cmd(ssh, cmd):
    """Ejecuta un comando en el servidor y devuelve (stdout, exit_code)"""
    try:
        stdin, stdout, stderr = ssh.exec_command(cmd, timeout=TIMEOUT_SSH)
        exit_status = stdout.channel.recv_exit_status()
        out = stdout.read().decode('utf-8', errors='ignore').strip()
        err = stderr.read().decode('utf-8', errors='ignore').strip()
        
        if exit_status == 0:
            return out, 0
        else:
            return err, exit_status
    except Exception as e:
        return str(e), -1

# --- LOGICA PRINCIPAL ---
def main():
    log("======================================================", "MAGENTA")
    log("  EXTRACTOR HOSTINGER -> PLESK (PARAMIKO EDITION)", "MAGENTA")
    log("======================================================", "MAGENTA")

    creds = leer_credenciales()
    dominios = leer_dominios()
    fallidos = []

    # 1. CONEXIÓN SSH
    log(f"[*] Conectando a {creds.get('ip', 'IP_DESCONOCIDA')}...", "CYAN")
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    
    try:
        ssh.connect(
            hostname=creds.get('ip'),
            port=int(creds.get('puerto', 22)),
            username=creds.get('usuario'),
            password=creds.get('clave'),
            timeout=15
        )
        log("[+] Conexión SSH establecida con éxito.", "GREEN")
    except Exception as e:
        log(f"[FATAL] Error de conexión SSH: {e}", "RED")
        exit(1)

    try:
        with SCPClient(ssh.get_transport()) as scp:
            for dominio in dominios:
                log("-" * 50)
                log(f">>> PROCESANDO: {dominio}", "CYAN")
                
                local_dir = os.path.join(os.getcwd(), dominio)
                os.makedirs(local_dir, exist_ok=True)
                has_error = False

                # 2. RESOLVER RUTA REMOTA (VERSIÓN BLINDADA)
                # Limpieza extrema de caracteres invisibles de Windows (BOM, \r, espacios)
                dominio_limpio = dominio.strip('\ufeff\r\n\t ')
                
                # Descubrimos la ruta absoluta real del usuario en Hostinger
                pwd_out, _ = run_cmd(ssh, "pwd")
                base_dir = pwd_out.strip()
                
                ruta_directa = f"{base_dir}/domains/{dominio_limpio}/public_html"
                out, code = run_cmd(ssh, f"test -d {ruta_directa} && echo SI || echo NO")
                
                remote_path = ruta_directa if "SI" in out else ""

                if not remote_path:
                    # Intento 2: Subdominio
                    parts = dominio_limpio.split('.', 1)
                    if len(parts) == 2:
                        ruta_sub = f"{base_dir}/domains/{parts[1]}/public_html/{parts[0]}"
                        out_sub, _ = run_cmd(ssh, f"test -d {ruta_sub} && echo SI || echo NO")
                        if "SI" in out_sub:
                            remote_path = ruta_sub
                            log("   [INFO] Detectado como subdominio.", "BLUE")

                if not remote_path:
                    log("   [ERROR] No se encontró ruta en Hostinger.", "RED")
                    # MODO DIAGNÓSTICO: Le pedimos a Hostinger que nos diga qué carpetas tiene realmente
                    ls_out, _ = run_cmd(ssh, f"ls -1 {base_dir}/domains/ | head -n 10")
                    carpetas = ls_out.replace('\n', ', ')
                    log(f"   [DIAGNÓSTICO] Carpetas detectadas: {carpetas}...", "GRAY")
                    fallidos.append(dominio)
                    continue

                # 3. PRE-CHECK LOCAL
                tar_name = f"{dominio}.tar.gz"
                sql_file = f"{dominio}.sql"
                local_tar_path = os.path.join(local_dir, tar_name)
                local_sql_path = os.path.join(local_dir, sql_file)

                if os.path.exists(local_tar_path) and os.path.exists(local_sql_path):
                    log("   [SKIP] Backup completo ya existe en la carpeta local.", "GREEN")
                    continue

                # 4. CREDENCIALES BD
                wp_config_remote = f"{remote_path}/wp-config.php"
                out_cfg, code_cfg = run_cmd(ssh, f"cat {wp_config_remote}")
                db_name, db_user, db_pass = "", "", ""
                
                if code_cfg == 0:
                    log("   -> Credenciales localizadas.", "YELLOW")
                    m_name = re.search(r"define\s*\(\s*['\"]DB_NAME['\"]\s*,\s*['\"](.+?)['\"]", out_cfg)
                    m_user = re.search(r"define\s*\(\s*['\"]DB_USER['\"]\s*,\s*['\"](.+?)['\"]", out_cfg)
                    m_pass = re.search(r"define\s*\(\s*['\"]DB_PASSWORD['\"]\s*,\s*['\"](.+?)['\"]", out_cfg)
                    
                    if m_name: db_name = m_name.group(1)
                    if m_user: db_user = m_user.group(1)
                    if m_pass: db_pass = m_pass.group(1)
                else:
                    log("   [WARN] wp-config.php no encontrado.", "YELLOW")

                # 5. TAR & DESCARGA ARCHIVOS
                if not os.path.exists(local_tar_path):
                    log("   -> Comprimiendo archivos en Hostinger...", "YELLOW")
                    run_cmd(ssh, f"rm -f ~/{tar_name}") # Limpiar viejo
                    out_tar, code_tar = run_cmd(ssh, f"tar -czf ~/{tar_name} -C {remote_path} .")
                    
                    if code_tar != 0 and "file changed as we read it" not in out_tar: # Ignora warning comun de tar
                        log(f"   [ERROR] Fallo al comprimir: {out_tar}", "RED")
                        has_error = True
                    else:
                        log(f"   -> Descargando {tar_name} vía SCP...", "CYAN")
                        try:
                            scp.get(f"{tar_name}", local_tar_path)
                            size_mb = round(os.path.getsize(local_tar_path) / (1024*1024), 2)
                            log(f"   [ÉXITO] Archivos descargados ({size_mb} MB).", "GREEN")
                            run_cmd(ssh, f"rm -f ~/{tar_name}") # Limpieza
                        except Exception as e:
                            log(f"   [ERROR] Fallo SCP: {e}", "RED")
                            has_error = True
                
                # 6. INYECTAR MEMORIA EN WP-CONFIG (Local)
                if not has_error and os.path.exists(local_tar_path):
                     log("   -> Procesando límites de memoria localmente...", "GRAY")
                     try:
                         with tarfile.open(local_tar_path, "r:gz") as tar:
                             member = None
                             for name in ["./wp-config.php", "wp-config.php"]:
                                 try:
                                     member = tar.getmember(name)
                                     break
                                 except KeyError: pass
                                 
                             if member:
                                 f_cfg = tar.extractfile(member)
                                 content_cfg = f_cfg.read().decode('utf-8', errors='ignore')
                                 if "WP_MEMORY_LIMIT" not in content_cfg:
                                     pattern = r"(define\s*\(\s*['\"]DB_PASSWORD['\"].+?\);)"
                                     replacement = r"\1\n\n// Anadido Limites de memoria\ndefine( 'WP_MEMORY_LIMIT', '512M' );\ndefine( 'WP_MAX_MEMORY_LIMIT', '1024M' );"
                                     new_content = re.sub(pattern, replacement, content_cfg)
                                     with open(os.path.join(local_dir, "wp-config.php"), "w", encoding="utf-8") as f_out:
                                         f_out.write(new_content)
                                     log("   [ÉXITO] wp-config.php modificado y guardado.", "CYAN")
                     except Exception as e:
                         log(f"   [ERROR] Extrayendo wp-config: {e}", "RED")

                # 7. EXPORTAR & DESCARGAR BASE DE DATOS
                if db_name and not has_error:
                    if not os.path.exists(local_sql_path):
                        log(f"   -> Exportando Base de Datos ({db_name})...", "YELLOW")
                        db_pass_escaped = db_pass.replace("'", "'\\''")
                        cmd_dump = f"mysqldump --no-tablespaces -u {db_user} -p'{db_pass_escaped}' {db_name} > ~/{sql_file}"
                        out_dump, code_dump = run_cmd(ssh, cmd_dump)
                        
                        if code_dump != 0:
                            log(f"   [ERROR] Fallo mysqldump: {out_dump}", "RED")
                            has_error = True
                        else:
                            log("   -> Descargando SQL vía SCP...", "CYAN")
                            try:
                                scp.get(f"{sql_file}", local_sql_path)
                                size_mb = round(os.path.getsize(local_sql_path) / (1024*1024), 2)
                                log(f"   [ÉXITO] BD Descargada ({size_mb} MB).", "GREEN")
                                run_cmd(ssh, f"rm -f ~/{sql_file}") # Limpieza
                            except Exception as e:
                                log(f"   [ERROR] Fallo SCP BD: {e}", "RED")
                                has_error = True
                
                if has_error and dominio not in fallidos:
                    fallidos.append(dominio)

    finally:
        ssh.close()

    # RESUMEN FINAL
    if fallidos:
        log("\n===========================================", "YELLOW")
        log(f"  RESUMEN: {len(fallidos)} FALLOS", "YELLOW")
        log("===========================================", "YELLOW")
        with open("fallos_pendientes.txt", "w") as f:
            for fail in fallidos:
                log(f" - {fail}", "RED")
                f.write(fail + "\n")
    else:
        log("\n===========================================", "GREEN")
        log("  FIN: MIGRACIÓN COMPLETADA SIN ERRORES", "GREEN")
        log("===========================================", "GREEN")
    
    input("\nPresiona ENTER para salir...")

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("\n[INTERRUMPIDO POR USUARIO]", "RED")
        input("Presiona ENTER para salir...")