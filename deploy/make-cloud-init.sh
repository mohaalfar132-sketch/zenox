#!/usr/bin/env bash
# يطبع كتلة cloud-init جاهزة: أنشئ الخادم والصقها في حقل "User data" بلا SSH.
# الاستخدام: bash deploy/make-cloud-init.sh <subdomain> <duckdns-token> <email> <tarball-url>
set -euo pipefail
SUB="${1:?subdomain}"; TOKEN="${2:?duckdns token}"; EMAIL="${3:-}"; TARBALL="${4:?tarball url}"
cat <<EOF
#cloud-config
package_update: true
packages: [curl, ca-certificates, tar, git]
runcmd:
  - mkdir -p /opt/zenox
  - curl -fsSL "${TARBALL}" -o /tmp/zenox-release.tgz
  - tar xzf /tmp/zenox-release.tgz -C /opt/zenox
  - cd /opt/zenox && bash deploy/setup-server.sh "${SUB}" "${TOKEN}" "${EMAIL}" > /var/log/zenox-install.log 2>&1
  - echo "ZENOX install finished: https://${SUB}.duckdns.org" >> /var/log/zenox-install.log
EOF
