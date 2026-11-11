#!/usr/bin/env bash
# RUSH B · «Дуэли» — ретранслятор списка серверов Cybershoke.
#
# Cybershoke показывает серверы в зависимости от страны, откуда пришёл запрос: серверу сайта на Cloudflare
# достаётся только часть (нет Москвы, Казахстана…). Этот скрипт ставит на VPS (Финляндия) службу, которая
# каждые 30 секунд берёт полный список и отправляет его серверу сайта. Входящие порты не нужны, Docker не нужен.
#
# Установка (Ubuntu/Debian):
#   curl -fsSL https://raw.githubusercontent.com/vsemvamdam/cs2-craft/main/tools/cybershoke-relay/install.sh | sudo bash
# Состояние:  systemctl status cs2-relay      Журнал:  journalctl -u cs2-relay -f
# Удаление:   sudo systemctl disable --now cs2-relay && sudo rm /etc/systemd/system/cs2-relay.service /usr/local/bin/cs2-relay
set -euo pipefail

SRC=https://cybershoke.net/api/api/v2/main/data
DST=https://cs2-craft-api.arnitonov.workers.dev/api/servers/push

[ "$(id -u)" = 0 ] || { echo "Запустите через sudo"; exit 1; }
if ! command -v curl >/dev/null || ! command -v gzip >/dev/null; then
  apt-get update -qq && apt-get install -y -qq curl gzip
fi

echo "1/3 Проверяю, какие серверы Cybershoke показывает этому IP ($(curl -4 -fsS -m 10 https://api.ipify.org || echo '?'))…"
n=$(curl -4 -fsS --compressed -m 40 "$SRC" | grep -o '"location":"moscow"' | wc -l || true)
echo "    московских серверов в списке: ${n:-0}"
if [ "${n:-0}" -eq 0 ]; then
  echo "С этого IP Cybershoke не отдаёт московские серверы — ставить ретранслятор сюда смысла нет."
  exit 1
fi

echo "2/3 Ставлю службу cs2-relay…"
cat > /usr/local/bin/cs2-relay <<'RELAY'
#!/usr/bin/env bash
# каждые 30 с: полный список Cybershoke → сервер сайта RUSH B (POST, gzip)
SRC=https://cybershoke.net/api/api/v2/main/data
DST=${CS2_RELAY_DST:-https://cs2-craft-api.arnitonov.workers.dev/api/servers/push}
UA='cs2-craft server list (+https://github.com/vsemvamdam/cs2-craft)'
F="${RUNTIME_DIRECTORY:-/tmp}/cybershoke.json"
ok=0; fails=0
while true; do
  if curl -4 -fsS --compressed -m 25 -A "$UA" -H 'Accept: application/json' -o "$F" "$SRC"; then
    code=$(gzip -c "$F" | curl -4 -sS -m 25 -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/gzip' --data-binary @- "$DST" || echo 000)
    if [ "$code" = 200 ]; then
      [ "$ok" = 0 ] && echo "список отправлен, дальше пишу в журнал только ошибки"
      ok=$((ok + 1)); fails=0
      [ $((ok % 2880)) = 0 ] && echo "работаю: за сутки отправлено 2880 списков"
    else
      fails=$((fails + 1)); [ "$fails" -le 3 ] || [ $((fails % 120)) = 0 ] && echo "сервер сайта ответил $code"
    fi
  else
    fails=$((fails + 1)); [ "$fails" -le 3 ] || [ $((fails % 120)) = 0 ] && echo "cybershoke.net не ответил"
  fi
  sleep 30
done
RELAY
chmod 755 /usr/local/bin/cs2-relay

cat > /etc/systemd/system/cs2-relay.service <<'UNIT'
[Unit]
Description=RUSH B: Cybershoke server list relay
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/cs2-relay
Restart=always
RestartSec=10
DynamicUser=yes
RuntimeDirectory=cs2-relay
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
MemoryMax=64M
CPUQuota=20%

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now cs2-relay >/dev/null 2>&1
systemctl restart cs2-relay

echo "3/3 Жду первую отправку…"
for _ in $(seq 1 20); do
  sleep 2
  if journalctl -u cs2-relay --since '-2 min' --no-pager -o cat | grep -q 'список отправлен'; then
    echo "Готово: список уходит на сервер сайта каждые 30 секунд."
    exit 0
  fi
done
echo "Первая отправка пока не прошла. Последние строки журнала:"
journalctl -u cs2-relay -n 10 --no-pager -o cat
exit 1
