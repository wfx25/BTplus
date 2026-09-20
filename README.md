# BT+

**A real-time, uncertainty-aware transit prediction system for Blacksburg Transit.**

🌐 **Live Demo:** https://inquisitive-cocada-b540a2.netlify.app

## What is BT+?

Blacksburg Transit provides real-time bus tracking and arrival information, but vehicle location updates can become stale between GPS reports.

BT+ estimates where a bus is **now** based on its last reported position, GTFS route geometry, current motion, and recent movement history. It also visualizes uncertainty so riders can see how much to trust the prediction.

**Trust → Predict → Verify**

## Features

* 🚌 Live Blacksburg Transit vehicle tracking
* 🗺️ GTFS route-aware map matching
* 🔮 Real-time bus position prediction
* 🤖 Gradient-boosted residual correction using recent bus motion
* 📏 P80 historical prediction uncertainty
* 🎨 Official route-based visualization
* ⏪ Replay system for historical bus data
* ✅ Automatic validation against later real-world bus updates

## How It Works

BT+ starts with a route-constrained constant-velocity prediction. For supported routes, a gradient-boosted tree model learns how much that baseline tends to over- or undershoot based on recent motion history.

When the next real bus update arrives, BT+ compares the prediction against the observed position, allowing the system to evaluate its predictions continuously.

## Tech Stack

**Frontend:** React, Vite, Leaflet
**Backend:** Node.js, JavaScript, Server-Sent Events
**Prediction & Analysis:** Python, scikit-learn, Gradient Boosting
**Transit Data:** Blacksburg Transit real-time data + GTFS

## Built at VTHacks 14

BT+ was built during VTHacks 14 at Virginia Tech.
