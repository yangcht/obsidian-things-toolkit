import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import typescript from "@rollup/plugin-typescript";

export default {
  input: "src/index.ts",
  output: {
    format: "cjs",
    file: "main.js",
    exports: "default",
    sourcemap: "inline",
  },
  external: ["obsidian", "child_process", "fs", "os", "path"],
  plugins: [
    typescript({ include: ["src/**/*.ts"] }),
    resolve({
      browser: true,
    }),
    commonjs(),
  ],
};
