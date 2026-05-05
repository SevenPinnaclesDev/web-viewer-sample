/*
 * SPDX-FileCopyrightText: Copyright (c) 2024 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: LicenseRef-NvidiaProprietary
 *
 * NVIDIA CORPORATION, its affiliates and licensors retain all intellectual
 * property and proprietary rights in and to this material, related
 * documentation and any modifications thereto. Any use, reproduction,
 * disclosure or distribution of this material and related documentation
 * without an express license agreement from NVIDIA CORPORATION or
 * its affiliates is strictly prohibited.
 */

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.tsx";
import { SpikeApp } from "./spike/SpikeApp.tsx";
import { AdminEntry } from "./components/admin/AdminEntry.tsx";
import "./index.css";

// Spike-mode escape hatch: ?spike=slots renders the slot-list spike harness
// instead of the streaming sample app. Lets the spike live alongside the
// streaming app without disturbing it. Drop the query to return.
//   — Ryan Takeda, 2026-04-30
//
// Admin route: /admin renders AdminEntry, which does its own whoami
// gate and mounts AdminPage. Streaming infrastructure isn't loaded
// for the admin path — keeps the surface focused and lets the two
// evolve independently. A real router can replace this when we have
// more than two routes, but for v1 a pathname check is the minimum
// viable thing.
//   — Ryan Takeda, 2026-05-04 (admin wave-2)
const params = new URLSearchParams(window.location.search);
const spike = params.get("spike");
const isAdminRoute = window.location.pathname === "/admin"
    || window.location.pathname.startsWith("/admin/");

let entry: React.ReactNode;
if (spike === "slots") {
    entry = <SpikeApp />;
} else if (isAdminRoute) {
    entry = <AdminEntry />;
} else {
    entry = <App />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>{entry}</React.StrictMode>,
);
