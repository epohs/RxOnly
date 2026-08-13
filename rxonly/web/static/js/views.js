/* ============================================
   RxOnly - Views, Polling & Initialization
   ============================================
   Home/dashboard view, node detail view,
   polling and background updates, connection
   error display, event handlers, and app
   initialization.
   ============================================ */

(function() {
  "use strict";

  var R = window.RxOnly;
  var app_state = R.app_state;
  var dom_elements = R.dom_elements;
  var config = R.config;
  var field_maps = R.field_maps;


  /* ------------------------------------------
     View Display Functions
     ------------------------------------------ */

  async function show_home_view() {
    R.save_read_position_before_leave();
    R.clear_saved_scroll_position();
    app_state.current_view = "home";
    app_state.current_channel_index = null;
    app_state.current_channel_name = null;
    app_state.current_channel_url = null;
    app_state.current_node_url = null;
    dom_elements.app_layout.classList.remove("viewing-detail");
    R.clear_sidebar_active();

    R.set_breadcrumbs([{ label: "Dashboard", href: "/", view: "home" }]);

    // Check if dashboard is already server-side rendered (first page load)
    var existing_dashboard = dom_elements.main_content.querySelector("#dashboard");
    if (existing_dashboard) {
      return;
    }

    // Navigating back to dashboard - clone template and populate
    dom_elements.main_content.innerHTML = "<p>Loading...</p>";

    try {
      var data = await R.fetch_stats();

      var content = R.populate_template("template-dashboard", data, field_maps.dashboard);
      if (content) {
        // Set the heading (requires conditional logic beyond simple field mapping)
        var heading = content.querySelector(".dashboard-node-name");
        var subheading = content.querySelector(".dashboard-node-short");
        var local_node = data.local_node || {};

        if (heading) {
          if (local_node.long_name) {
            heading.textContent = local_node.long_name;
          } else if (local_node.short_name) {
            heading.textContent = local_node.short_name;
          } else if (local_node.node_id) {
            heading.textContent = local_node.node_id;
          } else {
            heading.textContent = "Unknown Node";
          }
        }

        if (subheading) {
          if (local_node.long_name && local_node.short_name) {
            subheading.textContent = local_node.short_name;
          } else {
            subheading.textContent = "";
          }
        }

        dom_elements.main_content.innerHTML = "";
        dom_elements.main_content.appendChild(content);
      }

      R.update_page_title(data);
      check_for_state_change(data);
    } catch (error) {
      dom_elements.main_content.innerHTML = '<p class="error-state">Error loading dashboard: ' + R.escape_html(error.message) + '</p>';
      R.update_page_title(null);
    }
  }

  async function show_node_detail(node_api_url, from_content) {
    R.save_read_position_before_leave();

    // Save previous view context for breadcrumb navigation
    app_state.previous_view = app_state.current_view;
    app_state.previous_channel_index = app_state.current_channel_index;
    app_state.previous_channel_name = app_state.current_channel_name;
    app_state.previous_channel_url = app_state.current_channel_url;

    app_state.current_view = "node";
    app_state.current_node_url = node_api_url;
    dom_elements.app_layout.classList.add("viewing-detail");

    R.clear_sidebar_active();
    if (dom_elements.nodes_list) {
      var sidebar_node = dom_elements.nodes_list.querySelector('.node-link[href="' + node_api_url + '"]');
      if (sidebar_node) sidebar_node.classList.add("active");
    }

    dom_elements.main_content.innerHTML = "<p>Loading...</p>";

    try {
      var response = await fetch(node_api_url);
      var data = await response.json();

      if (!response.ok) {
        var error_msg = data.error || "Node not found";
        R.set_breadcrumbs([{ label: "Dashboard", href: "/", view: "home" }]);
        dom_elements.main_content.innerHTML = '<p class="error-state">' + R.escape_html(error_msg) + '</p>';
        return;
      }

      var node_name = data.long_name || data.short_name || data.node_id;

      // Build breadcrumbs with channel context only when navigated from message content
      var crumbs = [{ label: "Dashboard", href: "/", view: "home" }];

      if (from_content && app_state.previous_view === "channel" && app_state.previous_channel_name) {
        crumbs.push({
          label: app_state.previous_channel_name,
          href: app_state.previous_channel_url,
          view: "channel",
        });
      } else if (from_content && app_state.previous_view === "direct_messages") {
        crumbs.push({
          label: "Direct Messages",
          href: app_state.previous_channel_url,
          view: "direct_messages",
        });
      }

      crumbs.push({ label: node_name, href: node_api_url, view: "node" });
      R.set_breadcrumbs(crumbs);

      var content = R.populate_template("template-node-detail", data, field_maps.node_detail);
      if (content) {
        var detail_heading = content.querySelector("[data-field='heading']");
        if (detail_heading) {
          detail_heading.textContent = R.format_node_display_name(data);
        }

        // Show map link if both latitude and longitude are present
        if (data.latitude != null && data.longitude != null) {
          var map_link_container = content.querySelector(".node-map-link");
          var map_link = content.querySelector("[data-field='map-link']");
          if (map_link_container && map_link) {
            map_link.href = "https://www.openstreetmap.org/?mlat=" + data.latitude + "&mlon=" + data.longitude + "#map=9";
            map_link_container.removeAttribute("hidden");
          }
        }

        dom_elements.main_content.innerHTML = "";
        dom_elements.main_content.appendChild(content);
      }
    } catch (error) {
      R.set_breadcrumbs([{ label: "Dashboard", href: "/", view: "home" }]);
      dom_elements.main_content.innerHTML = '<p class="error-state">Error loading node</p>';
    }
  }


  /* ------------------------------------------
     Polling & Updates
     ------------------------------------------ */

  function check_for_state_change(stats_data) {
    if (!stats_data || !stats_data.local_node) return;

    var local_node = stats_data.local_node;

    // Initialize known state on first run
    if (app_state.known_local_node_id === null) {
      app_state.known_local_node_id = local_node.node_id;
      app_state.known_first_seen = local_node.first_seen;
      return;
    }

    // Check for device swap (node_id changed)
    if (local_node.node_id !== app_state.known_local_node_id) {
      console.log("Device changed, refreshing page...");
      window.location.reload();
      return;
    }

    // Check for database reset (first_seen changed)
    if (local_node.first_seen !== app_state.known_first_seen) {
      console.log("Database reset detected, refreshing page...");
      window.location.reload();
      return;
    }
  }

  function update_sidebar_counts(stats_data) {
    if (!stats_data || !stats_data.stats) return;

    // Use centralized function to update all node count displays
    R.update_all_node_counts(stats_data.stats.total_nodes);
  }

  function update_channel_counts(stats_data) {
    if (!stats_data || !stats_data.stats) return;

    var stats = stats_data.stats;
    var channel_counts = stats.channel_counts || {};

    if (dom_elements.channels_list) {
      dom_elements.channels_list.querySelectorAll(".channel-link").forEach(function(link) {
        var channel_index = link.dataset.channelIndex;
        var count_span = link.querySelector(".channel-count");

        if (!count_span) return;

        if (channel_index === "dm") {
          // `direct_message_count`, not `total_direct_messages`: this is the number
          // the unread cue bolds, so it counts what the DM list draws. The archive
          // total is a different question and the dashboard tile asks it. A server
          // too old to report the drawn count falls back to the total, which is what
          // this printed before and is wrong by only the folded reactions.
          var dm_count = stats.direct_message_count;
          if (typeof dm_count !== "number") dm_count = stats.total_direct_messages;
          count_span.textContent = "(" + dm_count + ")";
        } else {
          var count = channel_counts[parseInt(channel_index, 10)] || 0;
          count_span.textContent = "(" + count + ")";
        }
      });
    }
  }

  /**
   * Whether a channel holds anything the reader has not got to yet.
   *
   * **rx_time only, and this compared (rx_time, message_id) until it was found to be
   * wrong in both directions against a real archive.** message_id is the mesh packet
   * id — an arbitrary number from the sending radio — so it does not order anything.
   * Arrival order is the `id` key, which every message list sorts by and which the
   * stored read position does not carry. Ranking a tie by packet id therefore compared
   * two unrelated numbers: sometimes it hid an unread message, and sometimes it left a
   * channel bold that no amount of reading could clear, because the stored position is
   * the last row *in list order* and that row's packet id may be the lower one.
   *
   * A stored position always carries the rx_time of the last row the reader was on, and
   * that is at or after every inbound row's, so this can never stick — provided both
   * sides are talking about the same set of rows. They were not: the server reported
   * the newest row in the channel and the reader could only ever reach the newest row
   * the list *drew*, which is older whenever the last thing to arrive was a reaction.
   * `drawn_rows` in web/db.py is the fix for that, and get_unread_ceiling in rxonly.js
   * is the backstop. This comparison is the third side of the same rule and the only
   * one of the three that was already right.
   *
   * What it gives up is the tie: an inbound message in the same whole second as the
   * stored position does not raise the mark and waits for the next one in a later
   * second. Closing that means storing `id` in the read position, which is a change to
   * read tracking rather than to this comparison.
   *
   * A channel with no stored position has never been opened in this browser, so
   * everything in it is unread — which is what mesh-console does with a channel absent
   * from its cursors.
   *
   * `newest_rx_time` absent means the archive has nothing inbound to compare against —
   * a channel that has only ever heard this device, or one whose inbound rows are all
   * folded reactions. Nothing is waiting in either case. A server that does not report
   * the figure at all is a different question and does not reach here; see the guard
   * in update_channel_unread.
   *
   * @param {number|null|undefined} newest_rx_time
   * @param {{rx_time: number, message_id: number}|null} last_read
   * @returns {boolean}
   */
  function has_unread(newest_rx_time, last_read) {
    if (!newest_rx_time) return false;
    if (!last_read) return true;
    return newest_rx_time > last_read.rx_time;
  }

  /**
   * Re-evaluate the unread marks from the last stats the poll saw.
   *
   * Exists so that reading a channel clears its mark immediately instead of at the
   * next fast poll — see the callers in advance_last_read's users. The archive's side
   * of the comparison cannot have changed in the meantime, only the reader's, so the
   * cached payload is the right thing to compare against and there is no reason to
   * fetch.
   *
   * A no-op before the first poll has returned, which is the state a page is in for
   * its first moments.
   */
  function refresh_channel_unread() {
    if (!app_state.last_stats) return;
    update_channel_unread(app_state.last_stats);
  }

  /**
   * Put `unread` on the channel links that have something waiting, and take it off
   * the ones that do not.
   *
   * Separate from update_channel_counts, which it sits beside in the poll, because
   * the two answer different questions off different sources: a count comes from the
   * archive alone, and this needs the archive's newest message *and* a read position
   * that only this browser has. Read state here is localStorage, so it is per browser
   * and shares nothing with mesh-console's own read positions on the pi.
   *
   * **Three states, and they are not the same state.** A server that does not report a
   * figure at all leaves the sidebar exactly as it is — an older build should not have
   * every channel quietly go unbold. A server that reports it and has nothing inbound
   * means nothing is waiting, and the mark comes off. A figure newer than the stored
   * position means something is waiting. This used to check the first case for DMs and
   * not for channels, where a missing key fell through to has_unread and came back
   * false — the right answer by accident, off the wrong reasoning. `reports_dms` and
   * `reports_channels` name the distinction so both branches make it the same way.
   */
  function update_channel_unread(stats_data) {
    if (!stats_data || !stats_data.stats) return;
    if (!dom_elements.channels_list) return;

    var stats = stats_data.stats;

    // Present-and-null is a server that serves these and has nothing inbound; absent
    // is a server that does not report them. Only the second is a reason to abstain.
    var reports_channels = stats.channel_newest_inbound_rx_time != null;
    var reports_dms = stats.newest_inbound_direct_message_rx_time !== undefined;
    if (!reports_channels && !reports_dms) return;

    dom_elements.channels_list.querySelectorAll(".channel-link").forEach(function(link) {
      var channel_index = link.dataset.channelIndex;
      var is_dm = channel_index === "dm";
      var newest_rx_time;

      if (is_dm) {
        if (!reports_dms) return;
        newest_rx_time = stats.newest_inbound_direct_message_rx_time;
      } else {
        if (!reports_channels) return;
        newest_rx_time = stats.channel_newest_inbound_rx_time[parseInt(channel_index, 10)];
      }

      var last_read = R.get_last_read(is_dm, is_dm ? null : parseInt(channel_index, 10));
      link.classList.toggle("unread", has_unread(newest_rx_time, last_read));
    });
  }

  function update_dashboard_stats(stats_data) {
    if (app_state.current_view !== "home") return;
    if (!stats_data || !stats_data.stats) return;

    var dashboard = document.getElementById("dashboard");
    if (!dashboard) return;

    R.update_element(dashboard, stats_data, field_maps.dashboard);

    // Update heading (conditional logic)
    var local_node = stats_data.local_node || {};
    var heading = dashboard.querySelector(".dashboard-node-name");
    var subheading = dashboard.querySelector(".dashboard-node-short");

    if (heading) {
      if (local_node.long_name) {
        heading.textContent = local_node.long_name;
      } else if (local_node.short_name) {
        heading.textContent = local_node.short_name;
      } else if (local_node.node_id) {
        heading.textContent = local_node.node_id;
      }
    }

    if (subheading) {
      if (local_node.long_name && local_node.short_name) {
        subheading.textContent = local_node.short_name;
      } else {
        subheading.textContent = "";
      }
    }
  }

  async function run_fast_poll() {
    try {
      var stats_data = await R.fetch_stats();

      app_state.poll_failure_count = 0;
      hide_connection_error();

      // Kept so the unread marks can be recomputed when a read position moves without
      // waiting for the next poll — see refresh_channel_unread.
      app_state.last_stats = stats_data;

      check_for_state_change(stats_data);
      R.update_page_title(stats_data);
      update_sidebar_counts(stats_data);
      update_channel_counts(stats_data);
      update_channel_unread(stats_data);
      update_dashboard_stats(stats_data);

    } catch (error) {
      app_state.poll_failure_count++;
      console.error("Fast poll failed:", error);

      if (app_state.poll_failure_count >= config.max_poll_failures) {
        show_connection_error();
      }
    }
  }

  async function run_slow_poll() {
    // Update nodes list (skip if scroll is paused)
    if (!app_state.nodes_scroll_paused) {
      try {
        await R.update_nodes_list();
      } catch (error) {
        console.error("Slow poll (nodes) failed:", error);
      }
    }

    // Update messages if viewing a channel
    if (!app_state.messages_scroll_paused) {
      if (app_state.current_view === "channel" && app_state.current_channel_index !== null) {
        try {
          await update_messages_list(false);
        } catch (error) {
          console.error("Slow poll (messages) failed:", error);
        }
      } else if (app_state.current_view === "direct_messages") {
        try {
          await update_messages_list(true);
        } catch (error) {
          console.error("Slow poll (DMs) failed:", error);
        }
      }
    }

    // Update node detail if viewing
    if (app_state.current_view === "node" && app_state.current_node_url) {
      try {
        var response = await fetch(app_state.current_node_url);
        if (response.ok) {
          var node = await response.json();
          var node_detail = document.querySelector(".node-detail");
          if (node_detail) {
            R.update_element(node_detail, node, field_maps.node_detail);

            var detail_heading = node_detail.querySelector("[data-field='heading']");
            if (detail_heading) {
              detail_heading.textContent = R.format_node_display_name(node);
            }

            // Update map link if both latitude and longitude are present
            if (node.latitude != null && node.longitude != null) {
              var map_link_container = node_detail.querySelector(".node-map-link");
              var map_link = node_detail.querySelector("[data-field='map-link']");
              if (map_link_container && map_link) {
                map_link.href = "https://www.openstreetmap.org/?mlat=" + node.latitude + "&mlon=" + node.longitude + "#map=9";
                map_link_container.removeAttribute("hidden");
              }
            }
          }
        }
      } catch (error) {
        console.error("Slow poll (node detail) failed:", error);
      }
    }
  }

  /**
   * Poll for new messages and silently append them to the bottom.
   * Only fetches messages newer than what we already have loaded.
   * Updates the "Jump to newest" button state.
   */
  async function update_messages_list(is_direct_messages) {
    var messages_list = document.getElementById("messages-list");
    if (!messages_list) return;
    if (app_state.messages_is_loading) return;

    // If we have no cursor yet (empty view), skip poll update
    if (app_state.messages_newest_rx_time === null) return;

    try {
      var data = await R.fetch_message_page({
        is_dm: is_direct_messages,
        channel_index: is_direct_messages ? null : app_state.current_channel_index,
        after_rx_time: app_state.messages_newest_rx_time,
      });

      var messages = is_direct_messages ? data.direct_messages : data.messages;

      if (messages.length > 0) {
        // Update newest cursors
        var last = messages[messages.length - 1];
        app_state.messages_newest_rx_time = last.rx_time;
        app_state.messages_newest_id = last.id;

        // Silently append new messages to the bottom
        R.append_messages_to_list(messages_list, messages, is_direct_messages);

        // A row that lands inside the viewport has been read the moment it is drawn,
        // and this is the only thing in a position to notice. The scroll handler is
        // the only other caller of update_read_position, and a reader sitting still
        // watching a channel does not fire it — so a message arriving in full view
        // marked its channel bold and held it there until they scrolled for no
        // reason. Rows that land below the fold fail the threshold test inside and
        // correctly stay unread, which is the behaviour that was wanted all along.
        R.update_read_position();
      }

      // Update has_more_newer from the server response
      app_state.messages_has_more_newer = data.meta.has_more_newer;
      app_state.messages_total = data.meta.total;
      R.update_jump_to_newest_button();

    } catch (error) {
      console.error("Failed to update messages list:", error);
    }
  }

  function start_polling() {
    stop_polling();

    app_state.fast_poll_timer = setInterval(run_fast_poll, config.fast_poll_interval);
    app_state.slow_poll_timer = setInterval(run_slow_poll, config.slow_poll_interval);
  }

  function stop_polling() {
    if (app_state.fast_poll_timer) {
      clearInterval(app_state.fast_poll_timer);
      app_state.fast_poll_timer = null;
    }
    if (app_state.slow_poll_timer) {
      clearInterval(app_state.slow_poll_timer);
      app_state.slow_poll_timer = null;
    }
  }

  /**
   * Poll only while somebody is looking at the page.
   *
   * Both timers used to be started once at load and never touched again, so a tab
   * left open behind another one went on asking for /api/stats every ten seconds
   * and /api/nodes every twenty for as long as the browser lived, rendering all of
   * it into a document nobody could see. One forgotten tab was measured doing
   * ~340 requests an hour against the Pi.
   *
   * Coming back runs one of each poll straight away rather than waiting the
   * interval out. That is the whole reason this is safe to do: without it, hiding
   * a tab would trade a wasted request for a stale screen, and the first thing a
   * returning reader looks at is exactly the numbers the fast poll refreshes. Both
   * are called after the timers are re-armed, not before, so an await inside them
   * cannot delay the schedule.
   *
   * The immediate slow poll is subject to the same scroll pauses the interval one
   * is — `nodes_scroll_paused` and `messages_scroll_paused` are read inside
   * run_slow_poll — so a reader who comes back to a list they had scrolled into
   * keeps their place rather than having it reloaded out from under them.
   */
  function resume_polling() {
    start_polling();
    run_fast_poll();
    run_slow_poll();
  }

  function handle_visibility_change() {
    if (document.hidden) {
      stop_polling();
      return;
    }

    resume_polling();
  }


  /* ------------------------------------------
     Connection Error Display
     ------------------------------------------ */

  function show_connection_error() {
    if (document.getElementById("connection-error")) return;

    var error_div = document.createElement("div");
    error_div.id = "connection-error";
    error_div.className = "connection-error";
    error_div.textContent = "Connection issue - retrying...";

    document.body.insertBefore(error_div, document.body.firstChild);
  }

  function hide_connection_error() {
    var error_div = document.getElementById("connection-error");
    if (error_div) {
      error_div.remove();
    }
  }


  /* ------------------------------------------
     Hash Routing
     ------------------------------------------ */

  /**
   * Parse the current hash and route to the appropriate view.
   * Returns false for invalid routes (caller should redirect to dashboard).
   *
   * Supported patterns:
   *   ""  or "#"           → Dashboard
   *   "#node/!3265cf81"    → Node detail
   *   "#channel/1"         → Channel messages
   *   "#dm"                → Direct messages list
   *   "#message/2217203483"→ Channel message detail
   *   "#dm/2217203483"     → DM detail
   */
  async function route_from_hash(hash) {
    // Strip leading "#"
    var path = hash.replace(/^#/, "");

    // Empty hash → dashboard
    if (!path) {
      show_home_view();
      return true;
    }

    var parts = path.split("/");
    var route = parts[0];
    var param = parts.slice(1).join("/");  // rejoin in case param contains "/"

    if (route === "node" && param) {
      var node_url = R.build_node_url(param);
      var from_content = app_state.navigating_from_content;
      app_state.navigating_from_content = false;
      show_node_detail(node_url, from_content);
      return true;
    }

    if (route === "channel" && param) {
      var channel_index = parseInt(param, 10);
      if (isNaN(channel_index)) return false;

      // Look up channel name and API URL from sidebar
      var channel_link = dom_elements.channels_list
        ? dom_elements.channels_list.querySelector(
            '.channel-link[data-channel-index="' + channel_index + '"]'
          )
        : null;
      if (!channel_link) return false;

      var channel_name_el = channel_link.querySelector(".channel-name");
      var channel_name = channel_name_el
        ? channel_name_el.textContent.trim()
        : "Channel " + channel_index;
      var channel_api_url = channel_link.getAttribute("href");

      var result = await R.show_channel_messages(channel_api_url, channel_name, channel_index);
      return result !== false;
    }

    if (route === "dm" && !param) {
      // DM list
      var dm_link = dom_elements.channels_list
        ? dom_elements.channels_list.querySelector('.channel-link[data-channel-index="dm"]')
        : null;
      if (!dm_link) return false;

      var dm_api_url = dm_link.getAttribute("href");
      R.show_direct_messages(dm_api_url);
      return true;
    }

    if (route === "dm" && param) {
      // DM detail
      R.show_message_detail(param, true);
      return true;
    }

    if (route === "message" && param) {
      R.show_message_detail(param, false);
      return true;
    }

    return false;
  }

  function handle_hash_change() {
    var success = route_from_hash(location.hash);

    // route_from_hash is async, handle the promise
    if (success && typeof success.then === "function") {
      success.then(function(ok) {
        if (!ok) {
          // Invalid route — clear hash and go to dashboard
          history.replaceState(null, "", location.pathname);
          show_home_view();
        }
      });
    } else if (!success) {
      history.replaceState(null, "", location.pathname);
      show_home_view();
    }
  }


  /* ------------------------------------------
     Event Handlers
     ------------------------------------------ */

  function handle_channel_click(event) {
    var channel_link = event.target.closest(".channel-link");
    if (!channel_link) {
      return;
    }

    event.preventDefault();

    var channel_index = channel_link.dataset.channelIndex;

    if (channel_index === "dm") {
      location.hash = "dm";
    } else {
      location.hash = "channel/" + channel_index;
    }
  }

  function handle_node_click(event) {
    var node_link = event.target.closest(".node-link");
    if (!node_link) {
      return;
    }

    event.preventDefault();

    var node_id = node_link.dataset.nodeId;
    location.hash = "node/" + node_id;
  }
  
  function handle_nodes_heading_click(event) {
    if (!R.is_mobile_layout() && dom_elements.nodes_list) {
      dom_elements.nodes_list.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  function handle_breadcrumb_click(event) {
    var breadcrumb_link = event.target.closest("a");
    if (!breadcrumb_link) {
      return;
    }

    var view = breadcrumb_link.dataset.view;
    event.preventDefault();

    if (view === "home") {
      // If already on dashboard and breadcrumbs are sticky, scroll to top
      if (app_state.current_view === "home" && app_state.breadcrumb_is_sticky) {
        window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }

      if (location.hash) {
        location.hash = "";
      } else {
        show_home_view();
      }
    } else if (view === "channel") {
      var ch_index = app_state.current_channel_index != null
        ? app_state.current_channel_index
        : app_state.previous_channel_index;
      if (ch_index != null) {
        location.hash = "channel/" + ch_index;
      }
    } else if (view === "direct_messages") {
      location.hash = "dm";
    }
  }

  /**
   * Delegated click handler for main content area.
   * Handles: node links in messages, message timestamp links.
   */
  function handle_main_content_click(event) {
    // Reply bar click — navigate to parent message detail
    var reply_bar = event.target.closest(".message-reply-bar[data-reply-to-id]");
    if (reply_bar) {
      event.preventDefault();
      var reply_to_id = reply_bar.dataset.replyToId;
      var is_dm_reply = app_state.current_view === "direct_messages";
      location.hash = (is_dm_reply ? "dm/" : "message/") + reply_to_id;
      return;
    }

    // Message detail reply-to link — navigate to parent message
    var reply_to_link = event.target.closest(".message-detail-reply-to[data-reply-to-id]");
    if (reply_to_link) {
      event.preventDefault();
      var parent_id = reply_to_link.dataset.replyToId;
      var is_dm_context = app_state.current_view === "message" && app_state.previous_view === "direct_messages";
      location.hash = (is_dm_context ? "dm/" : "message/") + parent_id;
      return;
    }

    // Tapback pill click (check first — pills are inside message items)
    var tapback_pill = event.target.closest(".tapback-pill[data-tapback-id]");
    if (tapback_pill) {
      event.preventDefault();
      var tapback_id = tapback_pill.dataset.tapbackId;
      var is_dm = app_state.current_view === "direct_messages";
      location.hash = (is_dm ? "dm/" : "message/") + tapback_id;
      return;
    }

    // Message timestamp link (check before node-link to avoid catching it)
    var time_link = event.target.closest(".message-time-link");
    if (time_link) {
      event.preventDefault();
      var li = time_link.closest("li[data-message-id]");
      if (li) {
        var message_id = li.dataset.messageId;
        var is_dm_msg = app_state.current_view === "direct_messages";
        location.hash = (is_dm_msg ? "dm/" : "message/") + message_id;
      }
      return;
    }

    // Node link in messages
    var node_link = event.target.closest(".node-link");
    if (node_link) {
      event.preventDefault();
      app_state.navigating_from_content = true;
      var node_id = node_link.dataset.nodeId;
      location.hash = "node/" + node_id;
      return;
    }
  }


  /* ------------------------------------------
     Initialization
     ------------------------------------------ */

  function initialize_event_listeners() {
    // Channel clicks
    if (dom_elements.channels_list) {
      dom_elements.channels_list.addEventListener("click", handle_channel_click);
    }
    
    // Nodes list heading (sidebar)
    if (dom_elements.nodes_list_heading) {
      dom_elements.nodes_list_heading.addEventListener("click", handle_nodes_heading_click);
    }

    // Node clicks (sidebar)
    if (dom_elements.nodes_list) {
      dom_elements.nodes_list.addEventListener("click", handle_node_click);
      dom_elements.nodes_list.addEventListener("scroll", R.handle_nodes_scroll);
    }

    // Device bar home link
    var device_bar_home = document.querySelector(".device-bar-home");
    if (device_bar_home) {
      device_bar_home.addEventListener("click", function(event) {
        event.preventDefault();
        if (location.hash) {
          location.hash = "";
        } else {
          show_home_view();
        }
      });
    }

    // Hash routing
    window.addEventListener("hashchange", handle_hash_change);

    // Stop polling when the tab goes behind another one, and catch up on return.
    document.addEventListener("visibilitychange", handle_visibility_change);

    // Main content clicks (node links in messages, message timestamps)
    if (dom_elements.main_content) {
      dom_elements.main_content.addEventListener("click", handle_main_content_click);
    }

    // Nodes search
    if (dom_elements.nodes_search_input) {
      dom_elements.nodes_search_input.addEventListener("input", R.handle_nodes_search_input);

      dom_elements.nodes_search_input.addEventListener("keydown", function(event) {
        if (event.key === "Enter") {
          event.preventDefault();

          if (app_state.nodes_search_debounce_timeout) {
            clearTimeout(app_state.nodes_search_debounce_timeout);
          }

          app_state.nodes_search_query = dom_elements.nodes_search_input.value.trim();

          if (dom_elements.nodes_search_clear) {
            if (app_state.nodes_search_query === "") {
              dom_elements.nodes_search_clear.setAttribute("hidden", "");
            } else {
              dom_elements.nodes_search_clear.removeAttribute("hidden");
            }
          }

          R.fetch_and_render_nodes_search();
        }
      });
    }

    // Nodes search clear button
    if (dom_elements.nodes_search_clear) {
      dom_elements.nodes_search_clear.addEventListener("click", R.clear_nodes_search);
    }

    // Breadcrumb clicks
    if (dom_elements.breadcrumbs_list) {
      dom_elements.breadcrumbs_list.addEventListener("click", handle_breadcrumb_click);
    }

    // Messages scroll (delegated)
    R.setup_messages_scroll_listener();

    // Mobile infinite scroll (nodes + messages) + breadcrumb reveal
    window.addEventListener("scroll", function() {
      R.handle_window_scroll();
      R.handle_messages_window_scroll();
      R.handle_breadcrumb_scroll();
    }, { passive: true });
  }

  function initialize_app() {
    document.body.classList.remove("no-js");

    initialize_event_listeners();

    // Route based on initial hash, or show dashboard
    if (location.hash && location.hash !== "#") {
      route_from_hash(location.hash).then(function(ok) {
        if (!ok) {
          history.replaceState(null, "", location.pathname);
          show_home_view();
        }
      });
    } else {
      // Dashboard is server-side rendered on first load.
      // show_home_view detects #dashboard and skips the fetch.
      show_home_view();
    }

    // Not started at all when the page is loaded into a background tab — a
    // middle-clicked link, or a session the browser restored without showing.
    // The dashboard is server-side rendered, so the tab already has something
    // correct to show whenever it is first looked at, and the visibility handler
    // is what starts the timers and catches it up at that moment.
    if (!document.hidden) {
      start_polling();

      // And one straight away, for the same reason resume_polling does it. The
      // sidebar is server-rendered and index.html has no way to know this browser's
      // localStorage, so no channel arrives carrying `unread` — the first fast poll
      // is what puts the marks on. Left to the interval that is ten seconds during
      // which a channel with something waiting looks read, and then changes under the
      // reader. Called after the timers are armed so an await inside cannot delay the
      // schedule.
      run_fast_poll();
    }
  }

  /* ------------------------------------------
     Namespace Exports
     ------------------------------------------ */

  // The only thing this file exposes, and it is exposed for one caller:
  // save_read_position_before_leave in rxonly.js, which knows the read position has
  // moved but nothing about stats. Everything else here is reached through the DOM
  // events and timers set up below.
  R.refresh_channel_unread = refresh_channel_unread;


  // Run on DOM ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize_app);
  } else {
    initialize_app();
  }

})();
