import os
import re
import subprocess
import sys
import random
import string
import time

# ==============================================================================
# CONFIGURACIÓN DE SEGURIDAD Y LIMPIEZA
# ==============================================================================

# Lista negra de 70+ atacantes identificados en inyecciones SQL previas
BLACK_LIST_USERS = [
    'adminbockup', 'adminwp', 'adnankhokhar451@gmail.com', 'alfonzogambrel', 'archiveauth', 'archiveclient', 
    'archivefeed', 'archiveoption', 'archiveprofile', 'archivetable', 'archiveuser', 'articles_user', 
    'articlesclient', 'articlesfeed', 'articlesoption', 'articlespanel', 'articlesprofile', 'articlesrss', 
    'articlestable', 'articlesuse', 'articlesuser', 'assistantchiefa2fa', 'bgulyn8865', 'blogauth', 
    'blogclient', 'blogfeed', 'blogoption', 'blogprofile', 'blogtable', 'bloguser', 'bot', 'brennarobins2', 
    'caitlynmcclain', 'cathysimmons1', 'chonghickman858', 'cmsauth', 'cmsclient', 'cmseditor', 'cmsfeed', 
    'cmspanel', 'cmsprofile', 'cmsrss', 'cmstable', 'cmsuser', 'corechiefd27c', 'default', 'devauth', 
    'devclient', 'devfeed', 'devoption', 'devpanel', 'devprofile', 'devrss', 'devtable', 'devuser', 
    'editorpro906f', 'edzexegh', 'everettegunn32', 'gladismccombie7', 'gsujdhsu548fj@yopmail.com', 'hugoeaves2', 
    'josephbrien6023', 'ksragcnwuoht', 'lougault641', 'lucienney93', 'main_panel', 'mainauth', 'mainclient', 
    'mainfeed', 'mainpanel', 'mainprofile', 'mainrss', 'maintable', 'mainuser', 'maloriebraud3', 'mm3rttpdjz0q', 
    'naewtrer897509newetrewt', 'nartytryut1129117nehtyhyhtr', 'natregtegh3116218nerthrrth', 
    'natregtegh3171896nertytry', 'newsauth', 'newsclient', 'newsfeed', 'newsoption', 'newspanel', 
    'newsprofile', 'notesauth', 'notesfeed', 'notesoption', 'notespanel', 'notesprofile', 'notesrss', 
    'notestable', 'notesuser', 'operatoradmin158f', 'operatorhelper1696', 'operatordev185d', 
    'operatorleadb705', 'operatorninja1196', 'operatorpro1034', 'penniardill5', 'rgyc1ote4dgn', 'roy9661024', 
    'russellmartz8', 'salesninja8179', 'salesninja81bb', 'seomaster7416', 'sung12o12397315', 'support_admin', 
    'tonyamccue73490', 'trumpweiss', 'updatebot6a6f', 'utilkhgbyn', 'vgxkiara95', 'webclient', 'webfeed', 
    'weboption', 'webpanel', 'webrss', 'webtable', 'webuser', 'wpclient', 'wpoption', 'wppanel', 'wpprofile', 
    'wprss', 'wptable', 'wpuser', 'xfzdfqgzli', 'ydvpurotux'
]

# Patrones de archivos malware comunes
PATRONES_MALWARE = [
    "default.php", "info.php", "google*.html", "sitemap*.xml", 
    "index1.xml", "*.bak", "xmlrpc.php", ".user.ini"
]

# ==============================================================================
# FUNCIONES NUCLEARES
# ==============================================================================

def ejecutar_comando(comando, entrada_estandar=None, ocultar_salida=False):
    """Ejecuta comandos de sistema con blindaje contra fallos de existencia"""
    try:
        stdin_param = entrada_estandar if entrada_estandar else subprocess.PIPE
        resultado = subprocess.run(
            comando,
            shell=False,
            check=True,
            stdin=stdin_param,
            stdout=subprocess.PIPE if not ocultar_salida else subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True if not entrada_estandar else False
        )
        return resultado.stdout if not entrada_estandar else None
    except subprocess.CalledProcessError as e:
        error_msg = e.stderr if hasattr(e, 'stderr') and e.stderr else str(e)
        # Idempotencia: Si ya existe, no es un error crítico
        if "already exists" in error_msg or "already exists" in (e.stdout or ""):
            return None
        raise Exception(f"Fallo en {comando[0]}: {error_msg}")

def generar_usuario_plesk(dominio):
    """Genera usuario de sistema cumpliendo límites de Plesk (16 chars)"""
    base = re.sub(r'[^a-zA-Z0-9]', '', dominio.split('.')[0]).lower()[:8]
    if not base or not base[0].isalpha():
        base = "u" + base
    sufijo = ''.join(random.choices(string.ascii_lowercase + string.digits, k=7))
    return f"{base}_{sufijo}"

def limpiar_usuarios_maliciosos(nombre_bd, dominio):
    """Purga usuarios, metadata huérfana y corrige las URLs de WordPress"""
    print(f"[{nombre_bd}] Iniciando desinfección y ajuste de URLs...")
    
    # 1. Preparación de query de usuarios
    user_list_str = "'" + "','".join(BLACK_LIST_USERS) + "'"
    nueva_url = f"https://{dominio}"
    
    # SQL: Borrar usuarios basura + metadata huérfana + Corregir SiteURL y Home
    # Usamos prefijo wp_ por defecto (ajustar si el sitio usa otro)
    query_total = f"""
    -- Eliminar usuarios de lista negra y roles sospechosos
    DELETE u, m FROM wp_users u 
    LEFT JOIN wp_usermeta m ON u.ID = m.user_id 
    WHERE 
        u.user_login IN ({user_list_str}) 
        OR u.user_email IN ({user_list_str})
        OR (
            m.meta_key = 'wp_capabilities' 
            AND m.meta_value NOT LIKE '%administrator%' 
            AND m.meta_value NOT LIKE '%shop_manager%' 
            AND m.meta_value NOT LIKE '%editor%'
        );

    -- Limpiar metadata huérfana
    DELETE FROM wp_usermeta WHERE user_id NOT IN (SELECT ID FROM wp_users);

    -- Ajustar URLs del sitio para evitar redirecciones al servidor viejo
    UPDATE wp_options SET option_value = '{nueva_url}' WHERE option_name IN ('siteurl', 'home');
    """
    
    try:
        # Ejecutamos todo el bloque SQL
        ejecutar_comando(["plesk", "db", "-e", f"USE `{nombre_bd}`; {query_total}"])
        print(f"[{nombre_bd}] Usuarios purgados y URLs actualizadas a {nueva_url}.")
    except Exception as e:
        print(f"[ADVERTENCIA] Error en post-procesamiento de DB: {str(e)}")

def extraer_y_configurar_wp(ruta_dominio, dominio):
    """Extrae config y parcha límites de memoria"""
    path_config = os.path.join(ruta_dominio, "wp-config.php")
    archivo_tar = os.path.join(ruta_dominio, f"{dominio}.tar.gz")

    if not os.path.exists(path_config):
        if os.path.exists(archivo_tar):
            print(f"[{dominio}] Extrayendo wp-config del tar.gz...")
            ejecutar_comando(["tar", "-xzf", archivo_tar, "-C", ruta_dominio, "--wildcards", "*/wp-config.php", "--strip-components=1"])
            
    if not os.path.exists(path_config):
        raise Exception("No se pudo obtener el wp-config.php")

    with open(path_config, "r", encoding="utf-8", errors="ignore") as f:
        contenido = f.read()

    # Regex para extraer credenciales
    db_name = re.search(r"define\s*\(\s*['\"]DB_NAME['\"]\s*,\s*['\"]([^'\"]+)['\"]\s*\)", contenido)
    db_user = re.search(r"define\s*\(\s*['\"]DB_USER['\"]\s*,\s*['\"]([^'\"]+)['\"]\s*\)", contenido)
    db_pass = re.search(r"define\s*\(\s*['\"]DB_PASSWORD['\"]\s*,\s*['\"]([^'\"]+)['\"]\s*\)", contenido)
    
    if not all([db_name, db_user, db_pass]):
        raise Exception("Credenciales no encontradas en wp-config.php")

    # Inyección de performance
    if "WP_MEMORY_LIMIT" not in contenido:
        print(f"[{dominio}] Inyectando límites de memoria (512M)...")
        ajustes = "\n// Optimizacion KitDigital\ndefine( 'WP_MEMORY_LIMIT', '512M' );\ndefine( 'WP_MAX_MEMORY_LIMIT', '1024M' );\n"
        contenido = contenido.replace("<?php", f"<?php\n{ajustes}", 1)
        with open(path_config, "w", encoding="utf-8") as f:
            f.write(contenido)

    return db_name.group(1).strip(), db_user.group(1).strip(), db_pass.group(1).strip()

# ==============================================================================
# PROCESO PRINCIPAL POR DOMINIO
# ==============================================================================

def procesar_dominio_individual(dominio, ruta_dominio, ip_servidor):
    ruta_destino_httpdocs = f"/var/www/vhosts/{dominio}/httpdocs"
    print(f"\n" + "="*50)
    print(f"EJECUTANDO DESPLIEGUE: {dominio}")
    print("="*50)

    # Rutas de archivos
    sql_path = os.path.join(ruta_dominio, f"{dominio}.sql")
    tar_path = os.path.join(ruta_dominio, f"{dominio}.tar.gz")
    cfg_path = os.path.join(ruta_dominio, "wp-config.php")

    if not os.path.exists(sql_path) or not os.path.exists(tar_path):
        raise FileNotFoundError("Archivos base (.sql o .tar.gz) ausentes.")

    # 1. Obtener Credenciales
    nombre_bd, usuario_bd, clave_bd = extraer_y_configurar_wp(ruta_dominio, dominio)

    # 2. Suscripción en Plesk (Idempotente)
    check_sub = subprocess.run(["plesk", "bin", "subscription", "--info", dominio], capture_output=True)
    if check_sub.returncode != 0:
        print(f"[{dominio}] Creando nueva suscripción...")
        user_ftp = generar_usuario_plesk(dominio)
        pass_ftp = ''.join(random.choices(string.ascii_letters + string.digits, k=16)) + "A1!"
        ejecutar_comando([
            "plesk", "bin", "subscription", "--create", dominio,
            "-owner", "KitDigital", "-service-plan", "Default Domain", 
            "-ip", ip_servidor, "-login", user_ftp, "-passwd", pass_ftp
        ])
    else:
        print(f"[{dominio}] Dominio detectado en Plesk. Continuando...")

    # 3. MySQL Setup
    print(f"[{dominio}] Configurando Base de Datos...")
    ejecutar_comando(["plesk", "bin", "database", "--create", nombre_bd, "-domain", dominio, "-type", "mysql"])
    ejecutar_comando([
        "plesk", "bin", "database", "--create-dbuser", usuario_bd,
        "-passwd", clave_bd, "-domain", dominio, "-database", nombre_bd,
        "-server", "localhost", "-type", "mysql"
    ])

    # 4. Soft Reset (Limpieza de tablas existentes)
    print(f"[{dominio}] Limpiando tablas previas de la DB...")
    tablas_raw = ejecutar_comando(["plesk", "db", "-Ne", f"SHOW TABLES IN `{nombre_bd}`;"])
    if tablas_raw:
        ejecutar_comando(["plesk", "db", "-e", "SET FOREIGN_KEY_CHECKS = 0;"])
        for t in tablas_raw.strip().split('\n'):
            if t.strip():
                ejecutar_comando(["plesk", "db", "-e", f"DROP TABLE `{nombre_bd}`.`{t.strip()}`;"])
        ejecutar_comando(["plesk", "db", "-e", "SET FOREIGN_KEY_CHECKS = 1;"])

    # 5. Sanitización de SQL e Importación
    print(f"[{dominio}] Sanitizando SQL (Definers/Triggers)...")
    ejecutar_comando(["sed", "-i", r"s/DEFINER=[^ ]* //g", sql_path])
    ejecutar_comando(["sed", "-i", r"/\/\*\!50003 CREATE.*TRIGGER/,/\*\!50003 \*\//d", sql_path])

    print(f"[{dominio}] Importando Base de Datos...")
    # Usamos shell=True con f-string para asegurar que el redireccionamiento < funcione perfecto
    comando_importar = f"mysql -u '{usuario_bd}' -p'{clave_bd}' '{nombre_bd}' < '{sql_path}'"
    
    try:
        # Capturamos salida para ver qué dice MySQL exactamente
        resultado_mysql = subprocess.run(
            comando_importar, 
            shell=True, 
            check=True, 
            capture_output=True, 
            text=True
        )
        print(f"[{dominio}] Importación completada.")
    except subprocess.CalledProcessError as e:
        print(f"\n[ERROR CRÍTICO SQL] Falló la importación en {dominio}:")
        print(f"DETALLE: {e.stderr}")
        raise Exception(f"Error de MySQL: {e.stderr}")

    # 6. Purga de Seguridad DB y Ajuste de URLs
    # IMPORTANTE: Pasamos nombre_bd Y dominio
    limpiar_usuarios_maliciosos(nombre_bd, dominio)

    # 7. Despliegue de Archivos y Limpieza Malware
    print(f"[{dominio}] Desinfectando httpdocs...")
    if os.path.exists(ruta_destino_httpdocs):
        ejecutar_comando(["find", ruta_destino_httpdocs, "-mindepth", "1", "-delete"])
    
    # Extraer excluyendo config antiguo
    ejecutar_comando([
        "tar", "-xzf", tar_path, "-C", ruta_destino_httpdocs, 
        "--exclude=wp-config.php", "--exclude=*/wp-config.php"
    ])
    
    # Inyectar config maestro
    ejecutar_comando(["cp", "-f", cfg_path, os.path.join(ruta_destino_httpdocs, "wp-config.php")])

    # Cacería de archivos sospechosos en filesystem
    for p in PATRONES_MALWARE:
        ejecutar_comando(["find", ruta_destino_httpdocs, "-maxdepth", "2", "-name", p, "-delete"])
    
    # Matar backdoors en carpetas de uploads
    ups_dir = f"{ruta_destino_httpdocs}/wp-content/uploads"
    if os.path.exists(ups_dir):
        ejecutar_comando(["find", ups_dir, "-name", "*.php", "-type", "f", "-delete"])

    # Normalización .htaccess (Mata redirecciones y Error 500)
    print(f"[{dominio}] Normalizando .htaccess...")
    with open(os.path.join(ruta_destino_httpdocs, ".htaccess"), "w") as hf:
        hf.write("# BEGIN WordPress\nRewriteEngine On\nRewriteBase /\nRewriteRule ^index\\.php$ - [L]\nRewriteCond %{REQUEST_FILENAME} !-f\nRewriteCond %{REQUEST_FILENAME} !-d\nRewriteRule . /index.php [L]\n# END WordPress")

     # 8. Reparación, Toolkit e Inyección KitDigital
    print(f"[{dominio}] Reparando permisos y registrando en Toolkit...")
    # --- REPARACIÓN DE PROPIEDAD Y PERMISOS (EL FIX FINAL) ---
    print(f"[{dominio}] Detectando usuario del sistema para corregir propiedad...")
    try:
        # Obtenemos el usuario del sistema asignado por Plesk a este dominio
        user_sys = ejecutar_comando(["plesk", "db", "-Ne", f"SELECT login FROM sys_users WHERE id=(SELECT sys_user_id FROM hosting WHERE dom_id=(SELECT id FROM domains WHERE name='{dominio}'))"]).strip()
        
        if user_sys:
            print(f"[{dominio}] Cambiando dueño de archivos a {user_sys}:psaserv...")
            # Cambiamos recursivamente el dueño a usuario:psaserv (estándar de Plesk)
            ejecutar_comando(["chown", "-R", f"{user_sys}:psaserv", ruta_destino_httpdocs])
            # Forzamos permisos correctos: 755 carpetas, 644 archivos
            ejecutar_comando(["find", ruta_destino_httpdocs, "-type", "d", "-exec", "chmod", "755", "{}", "+"])
            ejecutar_comando(["find", ruta_destino_httpdocs, "-type", "f", "-exec", "chmod", "644", "{}", "+"])
            print(f"[{dominio}] Propiedad y permisos corregidos.")
        else:
            print(f"[AVISO] No se pudo determinar el usuario del sistema para {dominio}.")
    except Exception as e:
        print(f"[ERROR] Fallo al corregir propiedad: {str(e)}")
    ejecutar_comando(["plesk", "repair", "fs", "-y", dominio])
    
    try:
        id_dom = ejecutar_comando(["plesk", "db", "-Ne", f"SELECT id FROM domains WHERE name='{dominio}'"]).strip()
        ejecutar_comando(["plesk", "ext", "wp-toolkit", "--register", "-main-domain-id", id_dom, "-path", "httpdocs"])
        
        # Inyectar usuario administrador para el equipo
        print(f"[{dominio}] Inyectando usuario KitDigital...")
        pass_kit = ''.join(random.choices(string.ascii_letters + string.digits, k=14)) + "Kd1!"
        ejecutar_comando([
            "plesk", "ext", "wp-toolkit", "--wp-cli", 
            "-main-domain-id", id_dom, "-path", "httpdocs", "--", 
            "user", "create", "KitDigital", f"kitdigital@{dominio}", 
            "--role=subscriber", f"--user_pass={pass_kit}", "--send-email=no"
        ])
        print(f"   [OK] Usuario KitDigital listo (Clave: {pass_kit})")
    except Exception as e:
        print(f"   [AVISO] Toolkit no pudo completar la inyección: {str(e)}")

# ==============================================================================
# LANZADOR (CLI)
# ==============================================================================

if __name__ == "__main__":
    if os.geteuid() != 0:
        print("[FATAL] Debes ejecutar este script como root (sudo).")
        sys.exit(1)

    if len(sys.argv) < 3:
        print("Uso: python3 migrador_plesk.py <ruta_carpeta> <ip_servidor>")
        sys.exit(1)

    path_input = sys.argv[1].rstrip('/')
    server_ip = sys.argv[2]
    
    # Lógica de detección: ¿Es una carpeta de un dominio o un contenedor de muchas?
    contenidos = os.listdir(path_input)
    es_carpeta_directa = any(f.endswith('.sql') or f.endswith('.tar.gz') for f in contenidos)

    queue = []
    if es_carpeta_directa:
        queue.append((os.path.basename(path_input), path_input))
    else:
        for item in contenidos:
            sub_p = os.path.join(path_input, item)
            if os.path.isdir(sub_p):
                queue.append((item, sub_p))

    print(f"Iniciando despliegue de {len(queue)} sitio(s)...")
    
    for dom, ruta in queue:
        try:
            procesar_dominio_individual(dom, ruta, server_ip)
        except Exception as e:
            print(f"\n[ERROR CRÍTICO] Falló el despliegue de {dom}: {str(e)}\n")

    print("\n" + "="*50)
    print("PROCESO FINALIZADO")
    print("="*50)