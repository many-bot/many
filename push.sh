#!/bin/bash

rsync -avz --delete --exclude='data/' \
  --exclude='sessions/' \
  --exclude='cache/' \
  --exclude='settings.db*' \
  --exclude='telemetry.db*' \
  --exclude='scheduler.db*' \
  --exclude='alerts.log' \
  ./. admin@stxerr.dev:.manybot/
