import { connect, setup, key } from "./helpers.js";
const { service, ctx } = await setup({}, {}, 100);
const { call } = await connect(service, ctx);
const r = await call("link_ad", { job_id: "x", platform: "meta", platform_ad_id: "a", launch_mode: "separate", idempotency_key: key() });
console.log(r.text.slice(0,200));
process.exit(0);
