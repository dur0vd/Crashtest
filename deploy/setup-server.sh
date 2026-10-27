#!/usr/bin/env bash
# Настройка сервера Crashtest (Ubuntu/Debian). Запускается из GitHub Actions (server-setup.yml)
# под пользователем с sudo без пароля. Повторный запуск безопасен.
#
#   setup-server.sh <домен> <каталог сайта> <почта для Let's Encrypt>
#
# 1. Ставит nginx, certbot, rsync, открывает 80/443 в ufw, если он включён.
# 2. Пока нет сертификата — отдаёт сайт по HTTP (и проверку Let's Encrypt).
# 3. Если домен уже указывает на этот сервер — получает сертификат и включает HTTPS
#    (конфиг deploy/nginx.conf). Продление — системный таймер certbot.
set -euo pipefail

DOMAIN="$1"
SITE="$2"
EMAIL="$3"
SUDO="sudo -n"
CONF=/etc/nginx/sites-available/crashtest
ACME=/var/www/letsencrypt

$SUDO true 2>/dev/null || { echo "Пользователю $(whoami) нужен sudo без пароля (или запустите от root)." >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive
$SUDO apt-get update -qq
$SUDO apt-get install -y -qq nginx certbot rsync curl >/dev/null

$SUDO mkdir -p "$SITE/releases" "$ACME"
$SUDO chown -R "$(whoami)" "$SITE"
if [ ! -e "$SITE/current" ]; then
  mkdir -p "$SITE/releases/placeholder"
  echo '<!doctype html><meta charset="utf-8"><title>Crashtest</title><p>Сайт скоро появится.</p>' > "$SITE/releases/placeholder/index.html"
  ln -sfn "$SITE/releases/placeholder" "$SITE/current"
fi

if command -v ufw >/dev/null && $SUDO ufw status | grep -q "Status: active"; then
  $SUDO ufw allow 80/tcp >/dev/null
  $SUDO ufw allow 443/tcp >/dev/null
fi

# Конфиг до получения сертификата: сайт и проверка Let's Encrypt по HTTP.
http_conf() {
  cat <<EOF
log_format noip '[\$time_local] "\$request" \$status \$body_bytes_sent';
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name $DOMAIN www.$DOMAIN _;
    root $SITE/current;
    index index.html;
    charset utf-8;
    access_log /var/log/nginx/crashtest.log noip;
    location /.well-known/acme-challenge/ { root $ACME; }
    location / { try_files \$uri \$uri/ =404; }
}
EOF
}

# Без IPv6 в ядре строка «listen [::]» не даёт nginx запуститься — убираем её.
ipv6_filter() { if [ -e /proc/net/if_inet6 ]; then cat; else grep -v 'listen \[::\]'; fi; }

# Проверка конфига обязательна: при ошибке скрипт останавливается, старый конфиг nginx продолжает работать.
apply_nginx() {
  $SUDO ln -sfn "$CONF" /etc/nginx/sites-enabled/crashtest
  $SUDO rm -f /etc/nginx/sites-enabled/default
  $SUDO nginx -t
  $SUDO systemctl reload nginx 2>/dev/null || $SUDO systemctl restart nginx
}

CERT="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
if ! $SUDO test -f "$CERT"; then
  http_conf | ipv6_filter | $SUDO tee "$CONF" >/dev/null
  apply_nginx

  MYIP=$(curl -fsS -4 https://ifconfig.me || true)
  DNSIP=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)
  if [ -n "$MYIP" ] && [ "$MYIP" = "$DNSIP" ]; then
    DOMAINS="-d $DOMAIN"
    [ "$(getent ahostsv4 "www.$DOMAIN" | awk 'NR==1{print $1}')" = "$MYIP" ] && DOMAINS="$DOMAINS -d www.$DOMAIN"
    $SUDO certbot certonly --webroot -w "$ACME" $DOMAINS --non-interactive --agree-tos -m "$EMAIL" --keep-until-expiring
  else
    echo "DNS: $DOMAIN указывает на '${DNSIP:-ничего}', сервер — '$MYIP'. Сертификат будет получен при следующем запуске после настройки A-записи."
  fi
fi

if $SUDO test -f "$CERT"; then
  # Рабочий конфиг с HTTPS: тот же, что deploy/nginx.conf, с подставленными доменом и путём.
  sed -e "s#roadpdd\.ru#$DOMAIN#g" -e "s#/var/www/roadpdd/current#$SITE/current#g" "$(dirname "$0")/nginx.conf" | ipv6_filter | $SUDO tee "$CONF" >/dev/null
  # www — только если сертификат его покрывает
  if ! $SUDO openssl x509 -in "$CERT" -noout -ext subjectAltName 2>/dev/null | grep -q "www.$DOMAIN"; then
    $SUDO sed -i -e "s# www\.$DOMAIN##g" -e "/# www-begin/,/# www-end/d" "$CONF"
  fi
  apply_nginx
  # Продление сертификата перезагружает nginx.
  echo 'deploy-hook = systemctl reload nginx' | $SUDO tee /etc/letsencrypt/cli.ini >/dev/null
  echo "HTTPS включён: https://$DOMAIN"
fi
