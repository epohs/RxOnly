# Descriptions of the files in this directory

**Example scripts and configuration files for deploying RxOnly for yourself**

This folder contains a handful of example scripts that you can use to deploy this project for yourself. With the exception of `gunicorn.conf.py`, all of these scripts should be copied out of this project and installed in the appropriate locations on the system that will host the project.

Specific guidance on implementation is not within the scope of this project, but I’ve tried to give descriptions and context for how these files can be customized for you.

> **IMPORTANT:** Read the main [README](/README.md) in the root of this project for more information about the risks and concerns of running this project publicly. Don’t deploy this publicly if you don’t understand the dangers.


## [cloudflare-dyndns.sh](./cloudflare-dyndns.sh)

### Cloudflare Dynamic DNS Script

This script updates one or more Cloudflare DNS A records to point at the
current public IPv4 address of the host it runs on. It is intended for use
with cron on home or small-network systems where the external IP may change.

To configure it:
- Set `auth_key` to a Cloudflare API token with DNS edit access
- Set `zone_name` to your Cloudflare zone
- Add one or more fully-qualified record names to `record_names`

The script caches Cloudflare zone and record IDs, only updates DNS when the
IP changes, and logs all activity for audit and debugging.




## [cloudflare-sync-ips.sh](./cloudflare-sync-ips.sh)

**Cloudflare Real IP Configuration for nginx**

When nginx is running behind Cloudflare, all incoming requests originate from
Cloudflare proxy IPs instead of the real client. Without additional configuration,
this causes nginx to log, rate-limit, and apply access controls based on
Cloudflare IPs rather than the actual visitor.

This script solves that problem by automatically keeping nginx’s trusted
Cloudflare IP list up to date.

### What the script does

- Downloads Cloudflare’s official IPv4 and IPv6 address ranges
- Generates an nginx include file containing `set_real_ip_from` directives
- Configures nginx to trust the `CF-Connecting-IP` header
- Reloads nginx after validating the configuration

As a result, nginx correctly populates `$remote_addr` with the real client IP
for requests that pass through Cloudflare.

### Why this runs from cron

Cloudflare occasionally updates their proxy IP ranges. Running this script
periodically (via cron) ensures nginx always trusts the correct IPs without
manual intervention.

### Usage

Run this script periodically via cron and uncomment the `#include cloudflare;` line in my nginx.conf example file.




## [gunicorn.conf.py](./gunicorn.conf.py.example)

### Gunicorn Configuration (Optional)

The included `gunicorn.conf.py` provides a reference configuration for running
RxOnly under Gunicorn behind nginx. It defines worker counts, timeouts, logging,
and basic request limits.

This file is optional and is only used if Gunicorn is started with
`--config gunicorn.conf.py`; the systemd unit works independently without it.

If you want to customize Gunicorn runtime settings, copy
`gunicorn.conf.py.example` to `RxOnly/gunicorn.conf.py` and adjust as needed.




## [nginx.conf](./nginx.conf.example)

### Sample nginx Configuration

This file is an example **nginx server block** showing how to configure nginx to serve as a reverse proxy in front of the Flask application.

Using nginx as a reverse proxy is strongly recommended because it efficiently handles client connections and all of the complex production ready server things. This setup improves performance, reliability, and security, and avoids exposing Flask’s development server directly to the internet.

If you want to protect your Flask application from open public access you can use HTTP Basic Authentication.


### Install `htpasswd`

```
sudo apt install apache2-utils
```

### Create a password file

Pick a location nginx can read but isn’t web-accessible:

```
sudo mkdir -p /etc/nginx/auth
sudo htpasswd -c /etc/nginx/auth/rxonly.htpasswd yourusername
```

After creating this file, set it's permissions:

```
sudo chown root:nginx /etc/nginx/auth/rxonly.htpasswd   # or www-data
sudo chmod 640 /etc/nginx/auth/rxonly.htpasswd
```

### Uncomment the two lines indicated in the nginx.conf file for your RxOnly project



## [rxonly-collector.service](./rxonly-collector.service.example)

### Meshtastic Collector Service

This systemd unit runs the RxOnly Meshtastic collector as a persistent
background service. The collector connects to a locally attached Meshtastic
device over a serial interface and stores received messages and selected
channel data in a SQLite database.

The service is designed to run continuously and is automatically restarted
by systemd if the collector exits or crashes.




## [rxonly-www.service](./rxonly-www.service.example)

### systemd Service

The provided systemd unit runs the RxOnly Flask application using Gunicorn,
binding to localhost and expecting nginx to act as a reverse proxy.

Worker count and bind settings are hardcoded so the service functions without
a Gunicorn config file; comments in the unit explain how to switch to
`gunicorn.conf.py` if desired.
