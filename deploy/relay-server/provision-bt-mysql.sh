#!/usr/bin/env bash
set -euo pipefail

panel_database=/www/server/panel/data/default.db
relay_environment=/etc/astergate-relay.env
database_name=gpttool
database_user=gpttool_app

test -f "$panel_database"
test -f "$relay_environment"
panel_python=/www/server/panel/pyenv/bin/python
test -x "$panel_python"
mysql_root_password="$(
  cd /www/server/panel
  "$panel_python" -c "import sys; sys.path.insert(0, '/www/server/panel/class'); import public; print(public.M('config').where('id=?',(1,)).getField('mysql_root'))"
)"
test -n "$mysql_root_password"
database_password="$(openssl rand -hex 24)"

MYSQL_PWD="$mysql_root_password" mysql -uroot <<SQL
CREATE DATABASE IF NOT EXISTS \`$database_name\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL PRIVILEGES ON \`$database_name\`.* TO '$database_user'@'127.0.0.1' IDENTIFIED BY '$database_password';
FLUSH PRIVILEGES;
SQL

grep -v '^ASTERGATE_MYSQL_' "$relay_environment" > "$relay_environment.tmp"
printf 'ASTERGATE_MYSQL_HOST=127.0.0.1\n' >> "$relay_environment.tmp"
printf 'ASTERGATE_MYSQL_PORT=3306\n' >> "$relay_environment.tmp"
printf 'ASTERGATE_MYSQL_DATABASE=%s\n' "$database_name" >> "$relay_environment.tmp"
printf 'ASTERGATE_MYSQL_USER=%s\n' "$database_user" >> "$relay_environment.tmp"
printf 'ASTERGATE_MYSQL_PASSWORD=%s\n' "$database_password" >> "$relay_environment.tmp"
install -o root -g root -m 0600 "$relay_environment.tmp" "$relay_environment"
rm -f "$relay_environment.tmp"

sqlite3 "$panel_database" "DELETE FROM databases WHERE name='$database_name';
INSERT INTO databases(pid,name,username,password,accept,ps,addtime)
VALUES(0,'$database_name','$database_user','$database_password','127.0.0.1','GPTTool service database',datetime('now','localtime'));"

MYSQL_PWD="$database_password" mysql -h127.0.0.1 -u"$database_user" "$database_name" -Nse 'SELECT DATABASE(), CURRENT_USER();'
sqlite3 "$panel_database" "SELECT name,username,accept,ps FROM databases WHERE name='$database_name';"
