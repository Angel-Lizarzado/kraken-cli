import os
import sys
import time
import logging
import argparse
import paramiko
from paramiko.ssh_exception import SSHException, NoValidConnectionsError
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type
from dotenv import load_dotenv
import dns.resolver

# --- CONFIGURACIÓN E INICIALIZACIÓN ---
load_dotenv()

HOST = os.getenv("PLESK_HOST", "212.227.153.75")
USER = os.getenv("PLESK_USER", "root")
PASSWORD = os.getenv("PLESK_PASSWORD")
EMAIL = os.getenv("PLESK_EMAIL", "clinmediadev@gmail.com")

if not PASSWORD:
    print("Error: PLESK_PASSWORD no está definido en el archivo .env. Asegúrate de crearlo e incluir tus credenciales.")
    sys.exit(1)

# Variables por defecto
DEFAULT_DOMAINS_FILE = "dominios.txt"
DEFAULT_FAILED_FILE = "fallados.txt"

# --- LOGGING ---
logger = logging.getLogger("MigracionLogger")
logger.setLevel(logging.INFO)

c_handler = logging.StreamHandler()
f_handler = logging.FileHandler("migracion.log", mode='a', encoding='utf-8')

formatter = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s', datefmt='%Y-%m-%d %H:%M:%S')
c_handler.setFormatter(formatter)
f_handler.setFormatter(formatter)

logger.addHandler(c_handler)
logger.addHandler(f_handler)


# --- FUNCIONES NÚCLEO ---

def inicializar_archivos(archivo_fallos):
    """Limpia el archivo de fallos al inicio de la ejecución."""
    with open(archivo_fallos, 'w', encoding='utf-8') as f:
        f.write("")

def registrar_fallo(dominio, motivo, archivo_fallos):
    """Guarda en modo append el dominio fallido en esta ejecución."""
    with open(archivo_fallos, 'a', encoding='utf-8') as f:
        f.write(f"{dominio}\n")
    logger.warning(f"Guardado en lista de fallos: {dominio} ({motivo})")

def verificar_cloudflare(dominio):
    """
    Verifica si los Nameservers contienen 'cloudflare.com'.
    Uso de dnspython.
    """
    try:
        answers = dns.resolver.resolve(dominio, 'NS')
        for rdata in answers:
            if "cloudflare.com" in rdata.target.to_text().lower():
                return True
        return False
    except Exception as e:
        logger.warning(f"No se pudieron resolver los registros NS para {dominio}: {e}")
        return False

# Reintentos: stop_after_attempt(3) significa 1 intento normal + 2 reintentos.
@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=2, min=2, max=10),
    retry=retry_if_exception_type((SSHException, NoValidConnectionsError, TimeoutError, OSError, Exception)),
    reraise=True
)
def ejecutar_comando_ssh(ssh, comando):
    logger.debug(f"Ejecutando comando: {comando}")
    stdin, stdout, stderr = ssh.exec_command(comando)
    estado = stdout.channel.recv_exit_status()
    error = stderr.read().decode().strip()
    
    if estado != 0:
        # Se lanza excepción solo en fallo explícito del comando SSH si queremos forzar el retry de network.
        # No obstante, si Plesk devuelve un error distinto de 0 (ej. certificado no encontrado),
        # no queremos reintentar un error de cliente 3 veces. Es mejor capturarlo como error final y listo.
        pass
        
    return estado, error

def conectar_ssh():
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(HOST, username=USER, password=PASSWORD, timeout=10)
    return ssh

def procesar_dominio(dominio, ssh, archivo_fallos):
    logger.info(f"🚀 Procesando: {dominio}...")
    
    # 1. Validación Cloudflare
    if not verificar_cloudflare(dominio):
        logger.error(f"Falta exportar a Cloudflare: {dominio}. Se omitirá este dominio.")
        registrar_fallo(dominio, "Falta exportar a Cloudflare", archivo_fallos)
        return False
        
    logger.info(f"   [OK] Validación NS completada para {dominio}.")
    
    try:
        # Paso 1: Certificado SSL
        logger.info("   1. Solicitando e instalando certificado SSL...")
        comando_ssl = f"plesk ext sslit --certificate -issue -domain {dominio} -secure-domain -secure-www -secure-webmail -secure-mail -registrationEmail {EMAIL}"
        estado_ssl, error_ssl = ejecutar_comando_ssh(ssh, comando_ssl)
        
        if estado_ssl == 0:
            logger.info(f"   ✅ ¡Éxito! {dominio} configurado y protegido.")
            return True
        else:
            logger.error(f"   ❌ Error en SSL para {dominio}: {error_ssl}")
            registrar_fallo(dominio, f"Error SSL: {error_ssl}", archivo_fallos)
            return False

    except Exception as e:
        logger.error(f"   ❌ Excedidos los reintentos de conexión SSH o se produjo un Error Crítico en {dominio}", exc_info=True)
        registrar_fallo(dominio, "Excedidos los reintentos / Error Comando SSH", archivo_fallos)
        return False

# --- MOTOR PRINCIPAL ---

def main():
    parser = argparse.ArgumentParser(description="Automatización de Plesk DNS y SSL con validación NS.")
    parser.add_argument('--input', type=str, default=DEFAULT_DOMAINS_FILE, help='Archivo de texto con dominios a procesar.')
    parser.add_argument('--failed-file', type=str, default=DEFAULT_FAILED_FILE, help='Archivo de texto para guardar dominios fallidos.')
    parser.add_argument('--retry-failed', action='store_true', help='Llama a esta bandera para ejecutar sobre la lista de dominios fallidos en vez de la original.')
    args = parser.parse_args()
    
    archivo_entrada = args.failed_file if args.retry_failed else args.input
    archivo_fallos = args.failed_file
    
    if not os.path.exists(archivo_entrada):
        logger.error(f"El archivo {archivo_entrada} no existe de esta ruta.")
        sys.exit(1)
        
    with open(archivo_entrada, 'r', encoding='utf-8') as f:
        dominios = [linea.strip() for linea in f if linea.strip()]
        
    if not dominios:
        logger.info(f"La lista de dominios en {archivo_entrada} está vacía. Finalizando.")
        return
        
    mod_str = "[MODO REINTENTO DE FALLOS]" if args.retry_failed else "[MODO NORMAL]"
    logger.info(f"\n==============================================")
    logger.info(f"{mod_str} Procesando {len(dominios)} dominios...")
    logger.info(f"==============================================\n")
    
    # Sobrescribe y limpia el archivo de errores al arrancar 
    inicializar_archivos(archivo_fallos)

    ssh = None
    try:
        logger.info("Estableciendo conexión al servidor vía SSH...")
        ssh = conectar_ssh()
        logger.info("¡Conexión SSH exitosa!")
        
        for dominio in dominios:
            procesar_dominio(dominio, ssh, archivo_fallos)
            
    except Exception as e:
        logger.critical(f"No se pudo establecer o mantener la fase de conexión SSH inicial.", exc_info=True)
    finally:
        if ssh:
            ssh.close()
            logger.info("Conexión SSH finalizada y cerrada de manera segura.")
        logger.info("Proceso masivo finalizado. Misión cumplida.")

if __name__ == "__main__":
    main()