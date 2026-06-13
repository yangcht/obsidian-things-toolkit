import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import typescript from "@rollup/plugin-typescript";
import { env } from "process";

export default {
  input: "src/index.ts",
  output: {
    format: "cjs",
    file: "main.js",
    exports: "default",
  },
  external: ["obsidian", "child_process", "fs", "os", "path"],
  plugins: [
    typescript({ include: ["src/**/*.ts"], sourceMap: env.env === "DEV" }),
    resolve({
      browser: true,
    }),
    commonjs(),
  ],
};
