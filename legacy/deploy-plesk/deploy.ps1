# Parámetros iniciales
param (
    [string]$CarpetaLocalBackups = "D:\Centro de Control\respaldos\Hostinger1\Cloud9",
    [string]$IpServidor = "212.227.153.75",
    [string]$Usuario = "root"
)

$ArchivoLogExitos = Join-Path $CarpetaLocalBackups "migraciones_exitosas.log"
$ScriptPython = "migrador_plesk.py"
$RutaRemotaBase = "/root/migracion_wp"

# 1. Crear log local si no existe
if (-not (Test-Path $ArchivoLogExitos)) { New-Item $ArchivoLogExitos -ItemType File | Out-Null }

$Dominios = Get-ChildItem -Path $CarpetaLocalBackups -Directory
if ($Dominios.Count -eq 0) {
    Write-Host "[ERROR] No se encontraron carpetas de dominios." -ForegroundColor Red
    exit
}

Write-Host "--- Iniciando Orquestador Optimizado ---" -ForegroundColor Cyan

# 2. Preparar el terreno remoto y subir el script base UNA SOLA VEZ
Write-Host ">> Preparando servidor y subiendo script base..." -ForegroundColor Gray
ssh "$Usuario@$IpServidor" "mkdir -p $RutaRemotaBase"
scp ".\$ScriptPython" "${Usuario}@${IpServidor}:${RutaRemotaBase}/"

# 3. Iterar sobre los dominios
foreach ($CarpetaDominio in $Dominios) {
    $DominioNombre = $CarpetaDominio.Name
    
    # Check de resiliencia
    $YaMigrado = Select-String -Path $ArchivoLogExitos -Pattern "^$DominioNombre$"
    if ($YaMigrado) {
        Write-Host ">> [$DominioNombre] Ya migrado anteriormente. Saltando..." -ForegroundColor DarkGray
        continue
    }

    Write-Host "`n>>> PROCESANDO: $DominioNombre <<<" -ForegroundColor Yellow
    
    # 4. Transferencia de la carpeta completa (Una sola conexión SCP)
    # Al pasar la carpeta completa, scp crea la carpeta en destino automáticamente
    Write-Host "   Subiendo archivos pesados (SQL y TAR.GZ)..." -ForegroundColor Gray
    scp -r "$($CarpetaDominio.FullName)" "${Usuario}@${IpServidor}:${RutaRemotaBase}/"
    
    # Validación estricta: Si la transferencia falló (por internet), abortar este dominio
    if ($LASTEXITCODE -ne 0) {
        Write-Host "   [!] Error de red subiendo $DominioNombre. Abortando despliegue de este dominio." -ForegroundColor Red
        continue
    }

    # 5. Ejecutar migración y limpiar en un solo hit (Una sola conexión SSH)
    Write-Host "   Ejecutando despliegue en Plesk..." -ForegroundColor Gray
    
    # Concatenamos los comandos con '&&'. 
    # Si el script python falla, el rm -rf igual se ejecutará (usando ';') o no (usando '&&'). 
    # Lo ideal es limpiar siempre para no saturar el disco duro del servidor.
    $RutaDominioRemoto = "$RutaRemotaBase/$DominioNombre"
    $CmdRemoto = "python3 $RutaRemotaBase/$ScriptPython $RutaDominioRemoto $IpServidor ; rm -rf $RutaDominioRemoto"
    
    ssh "${Usuario}@${IpServidor}" $CmdRemoto
    
    # 6. Registro de éxito
    if ($LASTEXITCODE -eq 0) {
        Add-Content -Path $ArchivoLogExitos -Value $DominioNombre
        Write-Host "[$DominioNombre] Migración completada, limpiada y registrada." -ForegroundColor Green
    } else {
        Write-Host "[$DominioNombre] Falló el script en el servidor. Revisa los logs en Plesk." -ForegroundColor Red
    }
}

Write-Host "`n--- Proceso finalizado ---" -ForegroundColor Cyan