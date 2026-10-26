#!/bin/bash

rsync -avz --delete --exclude='data/' \
  --exclude='sessions/' \
  --exclude='cache/' \
  --exclude='settings.db*' \
  --exclude='telemetry.db*' \
  --exclude='scheduler.db*' \
  --exclude='alerts.log' \
  --exclude='accounts.json' \
  --exclude='history/' \
  ./. admin@stxerr.dev:.manybot/
