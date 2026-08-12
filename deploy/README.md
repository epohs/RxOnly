# Example scripts and configuration files for deploying RxOnly

This folder contains a handful of example scripts that you can use to deploy this project for yourself. With the exception of `gunicorn.conf.py`, all of these scripts should be copied out of this project and installed in the appropriate locations on the system that will host the project.

Specific guidance on implementation is not within the scope of this project, but I’ve tried to give descriptions and context for how these files can be customized for you.

> **IMPORTANT:** Refer to the main [README](/README.md) in the root of this project for more information about the risks and concerns of running this project publicly. Don’t deploy this publicly unless you understand the dangers.


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

If you do use it, install `logrotate.rxonly` alongside it — the `accesslog` and
`errorlog` paths it sets are two files that nothing else rotates.




## [logrotate.rxonly](./logrotate.rxonly.example)

### Log Rotation (only with `gunicorn.conf.py`)

Rotates the two log files `gunicorn.conf.py` points Gunicorn at. Without it they
grow forever: the access log is a line per request, and with a browser polling
every ten seconds per open tab that added up to 28 MB in about six months on my
own Pi.

**Edit the `create` line before you install it**, and check the edit took. It
names the user Gunicorn runs as — the same account as `User=` in
`rxonly-www.service` — and it ships as the literal string `YOURUSERNAME`, which
is not a user. logrotate answers an unknown user by discarding the *whole* block,
so the config sits there looking installed and rotates nothing at all.

```
sed -i 's/YOURUSERNAME/your-actual-username/' deploy/logrotate.rxonly.example
grep 'create 0640' deploy/logrotate.rxonly.example     # must not say YOURUSERNAME

sudo cp deploy/logrotate.rxonly.example /etc/logrotate.d/rxonly
sudo chown root:root /etc/logrotate.d/rxonly
sudo chmod 644 /etc/logrotate.d/rxonly
```

Then check it, rather than waiting a week to find out:

```
sudo logrotate --debug /etc/logrotate.d/rxonly    # says what it would do
sudo logrotate --force /etc/logrotate.d/rxonly    # actually does it, once
```

The `--debug` pass has to name both logs and print no `error:` line. `Handling 0
logs` means the block was thrown away — read the first few lines of the output for
which line it objected to.

After `--force`, the check that matters is not that the files were renamed but
that Gunicorn followed:

```
curl -s -o /dev/null http://127.0.0.1:8000/api/stats
ls -l /var/log/rxonly/
```

The new `gunicorn.access.log` must be **non-empty** after that request. If it is
still 0 bytes while `gunicorn.access.log.1` is the one growing, the `postrotate`
signal did not reach Gunicorn and it is still writing down the rotated inode —
the failure that looks fine for a week and then hands you one enormous `.1` and
an empty log. `sudo ls -l /proc/$(pgrep -f 'gunicorn --config' | head -1)/fd`
settles it either way: the access-log descriptor should point at the un-suffixed
path.

No `.gz` appears on this first pass, which is `delaycompress` working as
intended — the newest rotation is compressed on the *next* cycle, so it can still
be read without `zgrep`.

You do not need any of this if you start Gunicorn without `--config`, which is
what the systemd unit here does — that output goes to the journal, and journald
has its own limits.




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



## [rxonly-www.service](./rxonly-www.service.example)

### systemd Service

The provided systemd unit runs the RxOnly Flask application using Gunicorn,
binding to localhost and expecting nginx to act as a reverse proxy.

Worker count and bind settings are hardcoded so the service functions without
a Gunicorn config file; comments in the unit explain how to switch to
`gunicorn.conf.py` if desired.
