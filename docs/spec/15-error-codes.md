# 15 · Error Codes

The server returns `{error, code, params}`. The client shows the localized string `err_<code>`, where `.` and `-` in the code become `_`. Codes are dotted `module.reason`. For example, `coupon.max_stake_market` maps to `err_coupon_max_stake_market`. The same convention applies to notices (`notice_<code>`) and account messages (`msg_<code>`).

Every key from the source dictionary is listed below, grouped by module, with the condition that triggers it. Params are shown in braces. Client-only messages are marked (client).

## account

| Key | Trigger |
|---|---|
| `err_account_last_owner` {club} | Delete account while owning a club that has other members |
| `err_account_not_found` | The account no longer exists |
| `err_account_pin_wrong` | Wrong PIN on delete account (nothing deleted) |
| `err_account_platform_admin` | Tried to delete a platform admin account from the app |

## admin (platform accounts)

| Key | Trigger |
|---|---|
| `err_admin_create_missing` | Create account without username, PIN or type |
| `err_admin_name_length` | Display name not 1–30 characters |
| `err_admin_pin_digits` | PIN not 4–8 digits |
| `err_admin_role_invalid` | Account type other than player or admin |
| `err_admin_self_deactivate` | Admin tried to deactivate their own account |
| `err_admin_user_not_found` | Target account does not exist |
| `err_admin_username_taken` | Username already used |
| `aclub_err_diamonds` | Admin top-up amount is not a whole number of Diamonds (client) |
| `aclub_err_reference` | Admin top-up without a payment reference (client) |

## arena

| Key | Trigger |
|---|---|
| `err_arena_cancel_failed` | Cancelling a Stars checkout failed |
| `err_arena_cap_day` | Star purchase would exceed the daily spending cap (resets 00:00) |
| `err_arena_cap_month` | Would exceed the monthly cap |
| `err_arena_checkout_open` | Another Stars payment is still in progress |
| `err_arena_closed` | The Arena is not open |
| `err_arena_enter_failed` | Could not enter or claim in the Arena |
| `err_arena_not_a_club` | An Arena-only action was used outside the Arena, or a club action inside it |
| `err_arena_not_played` | The action needs at least one flop played |
| `err_arena_shop_closed` | The Stars shop is closed |
| `err_arena_unavailable` | The Arena failed to load |
| `err_arena_unknown_order` | Stars order not found |
| `err_arena_unknown_pack` | Stars pack not available |

## auth

| Key | Trigger |
|---|---|
| `err_auth_account_inactive` | Sign-in to a deactivated account |
| `err_auth_code_attempts` | Too many wrong email codes. A new code is needed |
| `err_auth_code_expired` | Email code expired (15 min for PIN reset) |
| `err_auth_code_invalid` | Wrong email code, or the client got fewer than 6 digits |
| `err_auth_code_missing` | No pending code for this flow |
| `err_auth_consent_invalid` | Marketing consent value not boolean |
| `err_auth_display_name_required` | Empty display name |
| `err_auth_display_name_too_long` | Display name over 30 characters |
| `err_auth_email_invalid` | Malformed email |
| `err_auth_email_required` | Registration without an email |
| `err_auth_email_send_failed` | The mail provider failed |
| `err_auth_email_taken` | Email belongs to another account |
| `err_auth_google_already_linked` | Linking Google while another Google identity is linked |
| `err_auth_google_disabled` | Google sign-in turned off |
| `err_auth_google_expired` | Google registration token too old |
| `err_auth_google_invalid` | Google credential failed verification |
| `err_auth_google_linked_elsewhere` | Google identity already linked to another account |
| `err_auth_pin_invalid` | PIN not 4–8 digits |
| `err_auth_pin_wrong` | Wrong PIN (login, PIN change, email or Google link confirmation) |
| `err_auth_terms_required` | 18+ or terms box not ticked |
| `err_auth_too_many` | Auth rate limit hit |
| `err_auth_username_taken` | Username already used |
| `err_user_username_invalid` | Username not 3–20 of letters, digits, `.`, `-`, `_` |
| `err_name_invalid_chars` | A name contains `< > " ' \` backslash or control characters |
| `err_session_expired` | Token expired |

## club

| Key | Trigger |
|---|---|
| `err_club_access_denied` | Not a member of the club |
| `err_club_already_member` | Join request by an existing member |
| `err_club_ambiguous` | A platform-level action on a player who is in several clubs, without a club named |
| `err_club_capability_missing` | Caller lacks the capability for this action in this club |
| `err_club_context_required` | Endpoint needs an active club, and none is selected |
| `err_club_create_failed` | Club creation failed (generic) |
| `err_club_delete_blocked` | Delete while tables, tournaments, requests, dealers or coupons are still live |
| `err_club_delete_name_mismatch` {club} | Typed name differs from the club name |
| `err_club_delete_owner_only` | Non-owner tried to delete |
| `err_club_delete_reason_required` | Delete without a reason |
| `err_club_description_too_long` | Description over 1,000 characters |
| `err_club_find_failed` | Club search failed (generic) |
| `err_club_free_limit` {club} | Owner already has a free club and creates or activates another free one |
| `err_club_id_invalid` | Club ID not 7 digits |
| `err_club_join_failed` | Join request failed (generic) |
| `err_club_leave_dealing` {table} | Leaving while seated as dealer |
| `err_club_leave_last_owner` | Owner tried to leave |
| `err_club_leave_live_coupons` {count} | Leaving with live coupons |
| `err_club_leave_tournament` {tournament} | Leaving while entered in an upcoming or running tournament |
| `err_club_level_required_billing` / `_staff` | Opening a table or accepting a member in a level-locked (second free) club |
| `err_club_live_big_invalid` | Big-pick threshold ≤ 0 or more than 2 decimals |
| `err_club_load_failed` | Clubs list failed (generic) |
| `err_club_logo_invalid` | Logo is not JPEG, PNG or WebP |
| `err_club_logo_too_large` | Logo over the size cap |
| `err_club_name_invalid` | Club name not 3–80 characters |
| `err_club_not_found` | No club with that ID |
| `err_club_nothing_to_change` | Profile save with no changes |
| `err_club_play_disabled` | Watch-only member tried to play or register |
| `err_club_play_staff` | Manager, inspector or dealer tried to play in their club |
| `err_club_request_not_found` | Join request already handled or missing |
| `err_club_request_pending` | Join request already pending |
| `err_club_requests_failed` | Loading join requests failed |
| `err_club_restore_admin_only` | Non-admin tried to restore a club |
| `err_club_restore_expired` {days} | Restore after the restore window |
| `err_club_restore_no_owner` | Restore when the original owner account is gone |
| `err_club_review_denied` | Non-staff tried to approve or reject a join |
| `err_club_review_failed` | Saving the join decision failed |
| `err_club_scan_already_member` | Scanned player is already a member |
| `err_club_scan_code_expired` | Player code older than its validity (about 1 min) |
| `err_club_scan_code_invalid` | Not a valid player code (signature or format) |
| `err_club_scan_code_old` | Legacy static player code |
| `err_club_scan_confirm_return` | Scanned player left or was removed before, and `confirmReturn` was not set |
| `err_club_scan_denied` | Scan by someone other than owner, manager or inspector |
| `err_club_scan_failed` | Scan processing failed |
| `err_club_select_failed` | Switching club failed |
| `err_club_settings_failed` | Settings save failed |
| `err_club_settings_forbidden` | Caller cannot change settings |
| `err_club_terms_owner_only` | Non-owner tried to accept club terms |
| `err_club_terms_required` | Club terms not accepted (create or updated terms) |

## commerce

| Key | Trigger |
|---|---|
| `err_commerce_billing_start_already_live` | Scheduling a billing start when charging is already live |
| `err_commerce_billing_start_date_invalid` | No or invalid date |
| `err_commerce_billing_start_too_soon` {hours} | Date closer than the minimum notice |
| `err_commerce_capacity_broadcasts_billing` / `_staff` {used, limit, nextLevel, resetDate} | Promotional message over the monthly quota |
| `err_commerce_capacity_members_billing` / `_staff` {used, limit, nextLevel, player} | Approving a member beyond the Level's member limit |
| `err_commerce_capacity_ring_games_billing` / `_staff` {used, limit, nextLevel} | Opening a Ring Game beyond the limit |
| `err_commerce_capacity_rooms_billing` / `_staff` {used, limit, nextLevel} | Adding a room beyond the limit |
| `err_commerce_capacity_tournaments_billing` / `_staff` {used, limit, nextLevel} | Starting a tournament beyond the running limit |
| `err_commerce_catalogue_missing` | No published price list for the requested product |
| `err_commerce_consent_required` | Checkout without the immediate-delivery consent |
| `err_commerce_document_not_found` | Receipt or credit note not issued yet |
| `err_commerce_document_unavailable` | Fetching the document from the invoicing provider failed |
| `err_commerce_forbidden` | Non-owner called a club billing endpoint |
| `err_commerce_game_unavailable` | Player action while the club is paused by billing |
| `err_commerce_level_free_club_held` {freeClub} | Moving to Starter while the owner has another free club |
| `err_commerce_level_free_club_held_owner` | Same, reported to a non-owner context |
| `err_commerce_level_insufficient_diamonds` {costD, balanceD, shortfallD} | Upgrade without enough Diamonds |
| `err_commerce_level_not_a_downgrade` | Downgrade target not lower |
| `err_commerce_level_not_an_upgrade` | Upgrade target not higher |
| `err_commerce_level_not_on_sale` | Level product not on sale |
| `err_commerce_level_tournaments_unavailable_billing` / `_staff` {requiredLevel} | Tournament action on a Level without tournaments |
| `err_commerce_notice_unknown` | Unknown notice kind in `notice/shown` |
| `err_commerce_order_not_found` | Order id unknown |
| `err_commerce_pack_not_found` | Diamond pack version not available |
| `err_commerce_paused_billing` / `_staff` | Action blocked by the paused account state |
| `err_commerce_payments_failed` | Stripe refused to create the session |
| `err_commerce_payments_unavailable` | Card payments disabled (use a manual request) |
| `err_commerce_promo_already_used` | This club already used the code |
| `err_commerce_promo_card_only` | Percent code used with "Add the Diamonds" |
| `err_commerce_promo_club_invalid` | Admin create: club does not exist |
| `err_commerce_promo_code_invalid` | Code not 4–24 of letters, digits or dashes |
| `err_commerce_promo_code_taken` | Code already exists |
| `err_commerce_promo_days_invalid` | Validity not 1–365 days |
| `err_commerce_promo_expired` {date} | Code past its expiry |
| `err_commerce_promo_gift_not_here` | Gift code entered at card checkout |
| `err_commerce_promo_inactive` | Code withdrawn |
| `err_commerce_promo_kind_invalid` | Kind not gift or percent |
| `err_commerce_promo_not_found` | Code unknown, or bound to another club |
| `err_commerce_promo_pack_invalid` | Pack id is not a Diamond pack |
| `err_commerce_promo_used_up` | Max uses reached |
| `err_commerce_promo_uses_invalid` | Uses not an integer 1–10,000 |
| `err_commerce_promo_value_invalid` | Percent not 1–99, or gift not a positive integer |
| `err_commerce_promo_wrong_pack` | Percent code bound to another pack |
| `err_commerce_refund_failed` | Stripe refused the refund (nothing changed) |
| `err_commerce_refund_ground_invalid` | Refund ground missing or invalid |
| `err_commerce_refund_not_refundable` | Order is not a paid card order |
| `err_commerce_refund_window_closed` {days} | Refund after the window |
| `err_commerce_topup_amount_invalid` | Top-up not a whole number |
| `err_commerce_topup_reference_required` | Top-up without a payment reference |
| `err_commerce_topup_request_not_found` | Diamond request already handled or missing |
| `err_commerce_tournament_unavailable` | Tournament not available (Level or paused) |
| `err_commerce_tournament_waiting` | Tournament waits for the club to start it |
| `err_commerce_unclassified` | Unexpected billing failure (no confirmed charge made) |

## coupon

| Key | Trigger |
|---|---|
| `err_coupon_bad_rounds` | Rounds not a positive integer |
| `err_coupon_bad_stake` | Stake not a positive valid amount |
| `err_coupon_dealer_own_table` | Caller is the dealer seated at this table |
| `err_coupon_duplicate_selections` | The same market twice on one slip |
| `err_coupon_insufficient_balance` | Points or Stars balance below the commitment |
| `err_coupon_insufficient_chips` {needed, available} | Tournament chips below the commitment |
| `err_coupon_levels_missing` | Tournament has no levels configured |
| `err_coupon_max_draws_tournament` {max} | Rounds exceed the flops left in the level or tournament |
| `err_coupon_max_rounds_table` {max} | Rounds exceed the table's max rounds |
| `err_coupon_max_stake` {max, unit} | Stake above the table or level max per pick |
| `err_coupon_max_stake_market` {name, max, unit} | Stake above the market's effective max |
| `err_coupon_min_stake` {min, unit} | Stake below the minimum (and not an allowed all-in) |
| `err_coupon_no_draws_left` | Tournament has no flops left |
| `err_coupon_no_selections` | Empty slip |
| `err_coupon_not_active` | Tournament entrant busted or eliminated |
| `err_coupon_not_found` | Coupon unknown |
| `err_coupon_not_live` | Operation on a completed or voided coupon |
| `err_coupon_not_on_menu_table` {names} | Market not allowed at this table |
| `err_coupon_not_on_menu_tournament` {names} | Market not allowed in this tournament |
| `err_coupon_not_registered` | Tournament table, but the caller is not registered |
| `err_coupon_over_commitment` {total, max, unit} | Σ stakes × rounds above the coupon cap |
| `err_coupon_over_exposure` {committed, pct, stack, cap} | Tournament commitment above pct% of the stack |
| `err_coupon_selection_already_cancelled` | Cancelling a leg that is already cancelled |
| `err_coupon_selection_not_on_coupon` | Leg cancel for a market not on the coupon |
| `err_coupon_selection_unavailable` | A market is inactive or deleted |
| `err_coupon_table_closed` | Table closed |
| `err_coupon_table_not_found` | Table unknown |

## dealer

| Key | Trigger |
|---|---|
| `err_dealer_auto_table` | Sitting at an auto-deal table |
| `err_dealer_busy_elsewhere` | Staff assigning a dealer who is seated at another table |
| `err_dealer_hand_live` {hand} | Stand up, switch or close while a hand is live |
| `err_dealer_held_hand_live` {table, club} | Switching while the held table in another club has a live hand |
| `err_dealer_holds_other` {table} | Sitting while already dealing another table |
| `err_dealer_not_dealing` | Hand action by someone not seated at the table |
| `err_dealer_not_found` | Assignee is not a dealer of the club |
| `err_dealer_own_live_coupons` {n, table} | Dealer has live coupons on the table they want to deal |
| `err_dealer_request_pending` | A second sit request while one is pending |
| `err_dealer_switch_stale` | Held seat changed during a switch |
| `err_dealer_table_changed` | Table state changed during the action |
| `err_dealer_table_taken` {table} | Table closed or already has a dealer |
| `err_dealer_you_deal_elsewhere` {table, club} | Sitting while seated in another club |

## hand, report, session, simulation

| Key | Trigger |
|---|---|
| `err_hand_not_found` | Hand not in this club |
| `err_report_range_invalid` | Report without both start and end |
| `err_report_range_order` | Start not before end |
| `err_session_not_found` | Analytics session id unknown |
| `err_simulation_budget_exceeded` | Budget release while still over the limit |
| `err_simulation_club_unsupported` | Simulation outside the simulation club |

## members

| Key | Trigger |
|---|---|
| `err_members_change_failed` | Role or play-mode save failed |
| `err_members_end_failed` | Ending a membership failed (nothing changed) |
| `err_members_forbidden` | Caller cannot manage members |
| `err_members_last_owner` | Change would leave the club without an owner |
| `err_members_load_failed` | Member list failed |
| `err_members_not_found` | Target is not a member |
| `err_members_one_owner` | Attempt to add a second owner |
| `err_members_owner_only` | Non-owner tried to transfer ownership |
| `err_members_owner_self` | Owner tried to transfer to themselves |
| `err_members_owner_state` | Owner record could not be read |
| `err_members_owner_transfer_only` | Owner role changed via the role endpoints instead of transfer |
| `err_members_play_mode_invalid` | Mode not play or watch |
| `err_members_rank_too_high` | Role at or above the caller's rank |
| `err_members_role_unknown` | Unknown role name |
| `err_members_self_change` | Changing one's own roles (other than dealer by a manager or owner) |
| `err_members_target_outranks` | Target's rank ≥ the caller's |

## messages

| Key | Trigger |
|---|---|
| `err_messages_action_unavailable` | Button target table or tournament no longer available |
| `err_messages_action_unknown` | Button type or target missing or invalid |
| `err_messages_audience_unknown` | Unknown audience key |
| `err_messages_body_required` | Empty body |
| `err_messages_empty_audience` {muted, capped} | Nobody in the audience can receive it now |
| `err_messages_member_not_found` | Recipient not in the club |
| `err_messages_not_found` | Message not in the caller's inbox |
| `err_messages_not_scheduled` | Cancel on a message no longer waiting |
| `err_messages_photo_invalid` | Photo is not JPEG, PNG or WebP |
| `err_messages_photo_too_large` {maxKb} | Photo over 120 KB |
| `err_messages_schedule_invalid` | Invalid send time |
| `err_messages_schedule_past` | Send time in the past |
| `err_messages_schedule_too_far` {days} | More than 30 days ahead |
| `err_messages_suggestion_unknown` | Dismissing an unknown suggestion |
| `err_messages_too_long` {max} | Body over 2,000 characters |

## points

| Key | Trigger |
|---|---|
| `err_points_amount_invalid` | Amount ≤ 0 or more than 2 decimals |
| `err_points_forbidden` | Supply statement requested by non owner or manager |
| `err_points_mint_owner_only` | Non-owner mint |
| `err_points_note_too_long` {n} | Staff note over the limit |
| `err_points_pool_short` {pool, needed} | Send Out or stock give exceeds the pool (non-owner). The owner is notified |
| `err_points_pool_short_owner` {pool, needed, short} | Same, for the owner (offers to mint the shortfall) |
| `err_points_reason_required` | Mint without a reason |
| `err_points_stock_failed` | Stock move failed |
| `err_points_stock_forbidden` | Stock move by non owner or manager |
| `err_points_stock_not_inspector` | Stock target is not an inspector |
| `err_points_stock_short` {stock, needed} | Inspector Send Out or approval exceeds their stock. The owner is notified |
| `err_points_stock_take_more_than_held` {stock, asked} | Take-back exceeds the stock |

## posters

| Key | Trigger |
|---|---|
| `err_posters_email_failed` | Emailing the poster failed |
| `err_posters_invalid` | Poster payload missing or invalid |
| `err_posters_no_email` | "Email it to me" without an account email |
| `err_posters_owner_only` | Non-owner |

## room

| Key | Trigger |
|---|---|
| `err_room_has_tables` | Deleting a room that has tables |
| `err_room_last` | Deleting the only room |
| `err_room_name_invalid` | Name not 2–40 characters |
| `err_room_name_taken` | Duplicate room name in the club |
| `err_room_not_found` | Room missing |
| `err_room_one_per_club` | Adding a second room |
| `err_room_reserved` | Editing the Simulation room |

## table

| Key | Trigger |
|---|---|
| `err_table_card_game_invalid` | Lobby-card game not nlh, plo or other |
| `err_table_card_photo_invalid` | Lobby photo type invalid |
| `err_table_card_photo_too_large` | Lobby photo too large |
| `err_table_card_tournament` | Editing the lobby card of a tournament table |
| `err_table_delete_changed` | Table changed during delete |
| `err_table_delete_coupons_riding` {n} | Delete with live coupons |
| `err_table_delete_hand_live` {hand} | Delete with a live hand |
| `err_table_delete_tournament` {tournament} | Delete a tournament's table |
| `err_table_limits_cap_below_min` | Coupon cap < min |
| `err_table_limits_invalid` | A limit < 0.01 or more than 2 decimals |
| `err_table_limits_market_invalid` {min} | Market max invalid or below the table min |
| `err_table_limits_max_below_min` | Max < min |
| `err_table_limits_tournament` | Ring Game limits on a tournament table |
| `err_table_not_found` | Table missing |
| `err_tournament_not_found` | Tournament missing (generic) |

## tournament (`trm`)

| Key | Trigger |
|---|---|
| `err_trm_addon_after_end` {rebuy, total} | Add-on window opens after the tournament ends |
| `err_trm_addon_already_taken` | Second add-on |
| `err_trm_addon_before_open` {addon, rebuy} | Add-on closes before it opens |
| `err_trm_addon_ended` | Add-on after its window |
| `err_trm_addon_needs_active` | Add-on by a busted or eliminated player |
| `err_trm_addon_no_chips` | Add-on with 0 chips |
| `err_trm_addon_not_started` | Add-on before the window opens |
| `err_trm_addons_not_allowed` | Add-on disabled |
| `err_trm_already_registered` | Duplicate registration |
| `err_trm_autostart_needs_time` | Auto start without `scheduledAt` |
| `err_trm_create_missing` | No name or no levels |
| `err_trm_dealer_or_auto` | Both or neither of dealer and auto-deal |
| `err_trm_insufficient_balance` {amount} | Not enough Points for buy-in, rebuy or add-on |
| `err_trm_latereg_after_end` {hand, total} | Late registration closes after the end |
| `err_trm_latereg_too_late` {hand, need, total, pct, last} | Late registration closes too late to meet participation |
| `err_trm_level_end_invalid` {level} | End hand not an integer ≥ 1 |
| `err_trm_level_end_order` {level, end, prev} | End hand not after the previous level |
| `err_trm_level_max_below` {level, max, min} | Level max < min |
| `err_trm_level_min_invalid` {level} | Level min ≤ 0 or more than 2 decimals |
| `err_trm_levels_order` {level} | Levels not numbered consecutively |
| `err_trm_levels_required` | No levels |
| `err_trm_levels_short` {end, total} | Last level ends before the final hand |
| `err_trm_max_rebuys` {max} | Rebuy limit reached |
| `err_trm_min_action_invalid` | Participation not an integer 0–100 |
| `err_trm_name_damaged` | Name contains a broken character |
| `err_trm_no_wallet` | No Points wallet in this club |
| `err_trm_not_active` | Action needs a running tournament |
| `err_trm_not_found` | Tournament unknown |
| `err_trm_not_registered` | Action needs registration |
| `err_trm_payouts_empty` | No prize places |
| `err_trm_payouts_not_numbers` | Payouts are not plain percentages |
| `err_trm_payouts_sum` {n} | Payouts do not sum to 100 |
| `err_trm_rebuy_needs_zero` | Rebuy with chips > 0 |
| `err_trm_rebuy_period_ended` | Rebuy after `rebuyEndHand` |
| `err_trm_rebuys_not_allowed` | Rebuys disabled |
| `err_trm_registration_closed` | Registration closed (started and late registration over, finished or cancelled) |
| `err_trm_scheduled_invalid` | Invalid start date |
| `err_trm_table_busy` {table} | Table already hosts an upcoming or running tournament |
| `err_trm_unregister_cutoff` {minutes} | Unregister within 1 minute of an auto start |
| `err_trm_unregister_started` | Unregister after the start |

## tv

| Key | Trigger |
|---|---|
| `err_tv_cash_only` | Ring Game TV requested for a tournament table |
| `err_tv_club_mismatch` | Table belongs to another club |
| `err_tv_club_missing` | Table has no club |
| `err_tv_pairing_code_invalid` | Code not 6 digits or unknown |
| `err_tv_pairing_expired` | Pairing code expired |
| `err_tv_pairing_rate_limited` | Too many claim attempts |
| `err_tv_pairing_unavailable` | Could not issue a code |
| `err_tv_table_closed` | Table not open |
| `err_tv_table_not_found` | Table unknown |

## generic (client)

| Key | Trigger |
|---|---|
| `err_network` | fetch failed or offline |
| `err_request_failed` {status} | Non-JSON or unknown server error |

## Notices (`notice_<code>`, not errors, same localization mechanism)

`dealer.wanted_elsewhere` {wantedBy, table, club}, `points.stock_short` {staff, tried, club, have}, `points.pool_short` {staff, tried, club, have}, `club.deleted` {club}, `club.restored` {club}.
