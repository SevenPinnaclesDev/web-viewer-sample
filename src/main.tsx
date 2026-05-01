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
import "./index.css";

// Spike-mode escape hatch: ?spike=slots renders the slot-list spike harness
// instead of the streaming sample app. Lets the spike live alongside the
// streaming app without disturbing it. Drop the query to return.
//   — Ryan Takeda, 2026-04-30
const params = new URLSearchParams(window.location.search);
const spike = params.get("spike");

ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
        {spike === "slots" ? <SpikeApp /> : <App />}
    </React.StrictMode>
);
