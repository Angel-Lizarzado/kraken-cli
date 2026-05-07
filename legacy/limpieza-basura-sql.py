import os
import subprocess
import uuid
from datetime import datetime

# --- CONFIGURACIÓN ---
# Detecta automáticamente la carpeta donde se está ejecutando el main.py
directorio_base = os.path.dirname(os.path.abspath(__file__))
archivo_dominios = os.path.join(directorio_base, "dominios.txt")
servidor_ssh = "root@212.227.153.75"
# ---------------------

if not os.path.exists(archivo_dominios):
    print(f"[ERROR] No se encontró el archivo de dominios en: {archivo_dominios}")
    exit(1)

# Generar un ID único para aislar esta ejecución y evitar colisiones
run_id = uuid.uuid4().hex[:6]
remoto_txt = f"/root/dominios_{run_id}.txt"
remoto_sh = f"/root/script_{run_id}.sh"

# 1. Subir lista de dominios al servidor
print(f"[*] Transfiriendo lista (ID Tarea: {run_id})...")
subprocess.run(["scp", archivo_dominios, f"{servidor_ssh}:{remoto_txt}"], capture_output=True)

# 2. Generar el script bash de auditoría y limpieza
payload_bash = f"""#!/bin/bash
ARCHIVO="{remoto_txt}"

echo "========================================================="
echo "      REPORTE DE AUDITORÍA Y DESINFECCIÓN TOTAL"
echo "      TAREA: {run_id} | FECHA: $(date '+%d/%m/%Y %H:%M:%S')"
echo "========================================================="

TOTAL_POSTS_ELIMINADOS=0
TOTAL_TERMS_ELIMINADOS=0
TOTAL_USERS_ELIMINADOS=0

while IFS= read -r DOMINIO; do
    DOMINIO=$(echo "$DOMINIO" | tr -d '\\r\\n ')
    DOMINIO=${{DOMINIO#www.}}
    [ -z "$DOMINIO" ] && continue
    
    DB_NAME=$(plesk db -Ne "SELECT db.name FROM data_bases db JOIN domains d ON db.dom_id = d.id WHERE d.name = '$DOMINIO' LIMIT 1;")
    if [ -z "$DB_NAME" ]; then echo ">>> $DOMINIO: [OMITIDO] Base de datos no encontrada."; continue; fi
    
    PREFIX=$(grep "table_prefix" /var/www/vhosts/$DOMINIO/httpdocs/wp-config.php 2>/dev/null | cut -d \\' -f 2)
    [ -z "$PREFIX" ] && PREFIX="wp_"

    SPAM_REGEX='casino|slot|bet|ruleta|tragamonedas|tragaperras|jackpot|blackjack|baccarat|poker|bingo|loto|keno|spins|apuestas|1xbet|gamstop'
    CONDITION_POSTS="(LOWER(post_title) REGEXP '$SPAM_REGEX' OR LOWER(post_name) REGEXP '$SPAM_REGEX' OR LOWER(post_content) REGEXP '$SPAM_REGEX')"
    CONDITION_USERS="WHERE (m.meta_value NOT LIKE '%administrator%' AND m.meta_value NOT LIKE '%shop_manager%' AND m.meta_value NOT LIKE '%editor%') OR u.user_login IN ('adminbockup', 'adminwp', 'adnankhokhar451@gmail.com', 'alfonzogambrel', 'archiveauth', 'archiveclient', 'archivefeed', 'archiveoption', 'archiveprofile', 'archivetable', 'archiveuser', 'articles_user', 'articlesclient', 'articlesfeed', 'articlesoption', 'articlespanel', 'articlesprofile', 'articlesrss', 'articlestable', 'articlesuse', 'articlesuser', 'assistantchiefa2fa', 'bgulyn8865', 'blogauth', 'blogclient', 'blogfeed', 'blogoption', 'blogprofile', 'blogtable', 'bloguser', 'bot', 'brennarobins2', 'caitlynmcclain', 'cathysimmons1', 'chonghickman858', 'cmsauth', 'cmsclient', 'cmseditor', 'cmsfeed', 'cmspanel', 'cmsprofile', 'cmsrss', 'cmstable', 'cmsuser', 'corechiefd27c', 'default', 'devauth', 'devclient', 'devfeed', 'devoption', 'devpanel', 'devprofile', 'devrss', 'devtable', 'devuser', 'editorpro906f', 'edzexegh', 'everettegunn32', 'gladismccombie7', 'gsujdhsu548fj@yopmail.com', 'hugoeaves2', 'josephbrien6023', 'ksragcnwuoht', 'lougault641', 'lucienney93', 'main_panel', 'mainauth', 'mainclient', 'mainfeed', 'mainpanel', 'mainprofile', 'mainrss', 'maintable', 'mainuser', 'maloriebraud3', 'mm3rttpdjz0q', 'naewtrer897509newetrewt', 'nartytryut1129117nehtyhyhtr', 'natregtegh3116218nerthrrth', 'natregtegh3171896nertytry', 'newsauth', 'newsclient', 'newsfeed', 'newsoption', 'newspanel', 'newsprofile', 'notesauth', 'notesfeed', 'notesoption', 'notespanel', 'notesprofile', 'notesrss', 'notestable', 'notesuser', 'operatoradmin158f', 'operatorhelper1696', 'operatordev185d', 'operatorleadb705', 'operatorninja1196', 'operatorpro1034', 'penniardill5', 'rgyc1ote4dgn', 'roy9661024', 'russellmartz8', 'salesninja8179', 'salesninja81bb', 'seomaster7416', 'sung12o12397315', 'support_admin', 'tonyamccue73490', 'trumpweiss', 'updatebot6a6f', 'utilkhgbyn', 'vgxkiara95', 'webclient', 'webfeed', 'weboption', 'webpanel', 'webrss', 'webtable', 'webuser', 'wpclient', 'wpoption', 'wppanel', 'wpprofile', 'wprss', 'wptable', 'wpuser', 'xfzdfqgzli', 'ydvpurotux')"
    COUNT_POSTS=$(plesk db -Ne "SELECT COUNT(*) FROM \`$DB_NAME\`.\`${{PREFIX}}posts\` WHERE $CONDITION_POSTS;")
    COUNT_TERMS=$(plesk db -Ne "SELECT COUNT(*) FROM \`$DB_NAME\`.\`${{PREFIX}}terms\` WHERE LOWER(slug) REGEXP '$SPAM_REGEX';")
    COUNT_USERS=$(plesk db -Ne "SELECT COUNT(DISTINCT u.ID) FROM \`$DB_NAME\`.\`${{PREFIX}}users\` u LEFT JOIN \`$DB_NAME\`.\`${{PREFIX}}usermeta\` m ON u.ID = m.user_id AND m.meta_key = '${{PREFIX}}capabilities' $CONDITION_USERS;")
    
    TOTAL_RIESGO=$((COUNT_POSTS + COUNT_TERMS + COUNT_USERS))

    echo ">>> $DOMINIO"

    # --- FASE 2: LIMPIEZA DE BASE DE DATOS ---
    if [ "$TOTAL_RIESGO" -gt 0 ]; then
        plesk db -e "DELETE FROM \`$DB_NAME\`.\`${{PREFIX}}posts\` WHERE $CONDITION_POSTS;"
        plesk db -e "DELETE pm FROM \`$DB_NAME\`.\`${{PREFIX}}postmeta\` pm LEFT JOIN \`$DB_NAME\`.\`${{PREFIX}}posts\` wp ON wp.ID = pm.post_id WHERE wp.ID IS NULL;"

        plesk db -e "DELETE FROM \`$DB_NAME\`.\`${{PREFIX}}terms\` WHERE LOWER(slug) REGEXP '$SPAM_REGEX';"
        plesk db -e "DELETE tt FROM \`$DB_NAME\`.\`${{PREFIX}}term_taxonomy\` tt LEFT JOIN \`$DB_NAME\`.\`${{PREFIX}}terms\` t ON tt.term_id = t.term_id WHERE t.term_id IS NULL;"
        plesk db -e "DELETE tr FROM \`$DB_NAME\`.\`${{PREFIX}}term_relationships\` tr LEFT JOIN \`$DB_NAME\`.\`${{PREFIX}}term_taxonomy\` tt ON tr.term_taxonomy_id = tt.term_taxonomy_id WHERE tt.term_taxonomy_id IS NULL;"

        plesk db -e "DELETE u FROM \`$DB_NAME\`.\`${{PREFIX}}users\` u LEFT JOIN \`$DB_NAME\`.\`${{PREFIX}}usermeta\` m ON u.ID = m.user_id AND m.meta_key = '${{PREFIX}}capabilities' $CONDITION_USERS;"
        plesk db -e "DELETE um FROM \`$DB_NAME\`.\`${{PREFIX}}usermeta\` um LEFT JOIN \`$DB_NAME\`.\`${{PREFIX}}users\` u ON u.ID = um.user_id WHERE u.ID IS NULL;"

        plesk db -e "TRUNCATE TABLE \`$DB_NAME\`.\`${{PREFIX}}comments\`;"
        plesk db -e "TRUNCATE TABLE \`$DB_NAME\`.\`${{PREFIX}}commentmeta\`;"

        echo "    - [BD] Entradas SPAM: $COUNT_POSTS eliminadas."
        echo "    - [BD] Taxonomías SPAM: $COUNT_TERMS eliminadas."
        echo "    - [BD] Usuarios irregulares: $COUNT_USERS eliminados."
        
        TOTAL_POSTS_ELIMINADOS=$((TOTAL_POSTS_ELIMINADOS + COUNT_POSTS))
        TOTAL_TERMS_ELIMINADOS=$((TOTAL_TERMS_ELIMINADOS + COUNT_TERMS))
        TOTAL_USERS_ELIMINADOS=$((TOTAL_USERS_ELIMINADOS + COUNT_USERS))
    else
        echo "    - [BD] Entorno seguro a nivel SQL."
    fi

    # Siempre borramos Triggers por seguridad
    TRIGGERS=$(plesk db -Ne "SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = '$DB_NAME';")
    for t in $TRIGGERS; do plesk db -e "DROP TRIGGER IF EXISTS \`$DB_NAME\`.\`$t\`;"; done

    # --- FASE 3: LIMPIEZA DE ARCHIVOS (BACKDOORS Y SEO) ---
    DOCROOT="/var/www/vhosts/$DOMINIO/httpdocs"
    if [ -d "$DOCROOT" ]; then
        # Borrar tokens de Google
        find "$DOCROOT" -maxdepth 1 -type f -name "google*.html" -exec rm -f {{}} \;
        
        # Borrar Sitemaps maliciosos y Web Shells
        [ -f "$DOCROOT/index1.xml" ] && rm -f "$DOCROOT/index1.xml"
        [ -f "$DOCROOT/sitemap1.xml" ] && rm -f "$DOCROOT/sitemap1.xml"
        [ -f "$DOCROOT/default.php" ] && rm -f "$DOCROOT/default.php"
        [ -f "$DOCROOT/info.php" ] && rm -f "$DOCROOT/info.php"
        
        echo "    - [ARCHIVOS] Backdoors y rastros SEO purgados del directorio."
    else
        echo "    - [ARCHIVOS] Advertencia: No se encontró el directorio httpdocs."
    fi

    # --- FASE 4: CORRECCIÓN DE ENLACES (QUITAR WWW.) ---
    DOM_ID=$(plesk db -Ne "SELECT id FROM domains WHERE name='$DOMINIO'")
    if [ -n "$DOM_ID" ]; then
        plesk ext wp-toolkit --wp-cli -main-domain-id $DOM_ID -path httpdocs -- search-replace "www.$DOMINIO" "$DOMINIO" --all-tables --quiet
        echo "    - [ENLACES] Referencias a www.$DOMINIO reemplazadas por $DOMINIO correctamente."
    fi

done < "$ARCHIVO"

echo "========================================================="
echo "RESUMEN DE OPERACIONES:"
echo "Total de entradas SPAM eliminadas: $TOTAL_POSTS_ELIMINADOS"
echo "Total de taxonomías SEO eliminadas: $TOTAL_TERMS_ELIMINADOS"
echo "Total de usuarios irregulares eliminados: $TOTAL_USERS_ELIMINADOS"
echo "========================================================="
"""

# 3. Guardar y Subir script local
ruta_script_local = os.path.join(directorio_base, f"script_{run_id}.sh")
with open(ruta_script_local, "w", encoding="utf-8", newline='\n') as f:
    f.write(payload_bash)

subprocess.run(["scp", ruta_script_local, f"{servidor_ssh}:{remoto_sh}"], capture_output=True)
subprocess.run(["ssh", servidor_ssh, f"chmod +x {remoto_sh}"], capture_output=True)

# 4. Ejecutar y generar reporte
nombre_reporte = f"REPORTE_DESINFECCION_{datetime.now().strftime('%Y%m%d_%H%M')}_{run_id}.txt"
ruta_reporte_local = os.path.join(directorio_base, nombre_reporte)

print(f"[*] Ejecutando auditoría remota y limpieza. Generando: {nombre_reporte}\n")

with open(ruta_reporte_local, "w", encoding="utf-8") as reporte:
    proceso = subprocess.Popen(
        ["ssh", servidor_ssh, remoto_sh],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",       
        errors="replace",       
        bufsize=1
    )

    for linea in iter(proceso.stdout.readline, ''):
        salida_limpia = linea.strip()
        print(salida_limpia)
        reporte.write(salida_limpia + "\n")

    proceso.stdout.close()
    proceso.wait()

# 5. Limpieza del servidor (Borrar archivos temporales de esta sesión)
print("\n[*] Limpiando archivos temporales en el servidor remoto...")
subprocess.run(["ssh", servidor_ssh, f"rm -f {remoto_txt} {remoto_sh}"], capture_output=True)

# Limpieza del script sh local
if os.path.exists(ruta_script_local):
    os.remove(ruta_script_local)

print(f"[*] Tarea {run_id} finalizada. Servidor limpio. Reporte en: {ruta_reporte_local}")