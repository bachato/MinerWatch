// vite.config.ts
import { defineConfig } from "file:///sessions/relaxed-inspiring-goodall/mnt/MinerWatch/frontend-react/node_modules/vite/dist/node/index.js";
import react from "file:///sessions/relaxed-inspiring-goodall/mnt/MinerWatch/frontend-react/node_modules/@vitejs/plugin-react/dist/index.js";
import path from "node:path";
var __vite_injected_original_dirname = "/sessions/relaxed-inspiring-goodall/mnt/MinerWatch/frontend-react";
var vite_config_default = defineConfig({
  base: "/v2/",
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__vite_injected_original_dirname, "./src")
    }
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: false
      },
      "/sw.js": {
        target: "http://localhost:8000",
        changeOrigin: false
      }
    }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    // Chunk strategy: react + react-dom in their own chunk so they get
    // cached across deploys when only app code changes.
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
          query: ["@tanstack/react-query"],
          charts: ["recharts"]
        }
      }
    }
  }
});
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCIvc2Vzc2lvbnMvcmVsYXhlZC1pbnNwaXJpbmctZ29vZGFsbC9tbnQvTWluZXJXYXRjaC9mcm9udGVuZC1yZWFjdFwiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiL3Nlc3Npb25zL3JlbGF4ZWQtaW5zcGlyaW5nLWdvb2RhbGwvbW50L01pbmVyV2F0Y2gvZnJvbnRlbmQtcmVhY3Qvdml0ZS5jb25maWcudHNcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfaW1wb3J0X21ldGFfdXJsID0gXCJmaWxlOi8vL3Nlc3Npb25zL3JlbGF4ZWQtaW5zcGlyaW5nLWdvb2RhbGwvbW50L01pbmVyV2F0Y2gvZnJvbnRlbmQtcmVhY3Qvdml0ZS5jb25maWcudHNcIjtpbXBvcnQgeyBkZWZpbmVDb25maWcgfSBmcm9tICd2aXRlJztcbmltcG9ydCByZWFjdCBmcm9tICdAdml0ZWpzL3BsdWdpbi1yZWFjdCc7XG5pbXBvcnQgcGF0aCBmcm9tICdub2RlOnBhdGgnO1xuXG4vLyBNaW5lcldhdGNoIGZyb250ZW5kIFx1MjAxNCBWaXRlIGNvbmZpZy5cbi8vXG4vLyBUaGUgYnVpbGQgaXMgc2VydmVkIGJ5IEZhc3RBUEkgdW5kZXIgL3YyLyAoc2VlIGJhY2tlbmQvbWFpbi5weSkuIFdoZW5cbi8vIHlvdSBjaGFuZ2UgdGhpcyBiYXNlLCB0aGUgc3RhdGljIGFzc2V0IGhyZWZzIGNoYW5nZSB3aXRoIGl0OyB0aGUgZGV2XG4vLyBzZXJ2ZXIgaXMgdW5hZmZlY3RlZCBiZWNhdXNlIGl0IHNlcnZlcyBmcm9tIC8uXG4vL1xuLy8gSW4gZGV2IG1vZGUgKGBucG0gcnVuIGRldmApLCBWaXRlIHJ1bnMgb24gOjUxNzMgYW5kIHByb3hpZXMgL2FwaS8qXG4vLyBhbmQgL3N3LmpzIHRvIHRoZSBGYXN0QVBJIGJhY2tlbmQgb24gOjgwMDAgc28geW91IGNhbiBjYWxsIHRoZSByZWFsXG4vLyBBUEkgYW5kIGV4ZXJjaXNlIHB1c2ggbm90aWZpY2F0aW9ucyB3aXRob3V0IENPUlMgZ3ltbmFzdGljcy5cbmV4cG9ydCBkZWZhdWx0IGRlZmluZUNvbmZpZyh7XG4gIGJhc2U6ICcvdjIvJyxcbiAgcGx1Z2luczogW3JlYWN0KCldLFxuICByZXNvbHZlOiB7XG4gICAgYWxpYXM6IHtcbiAgICAgICdAJzogcGF0aC5yZXNvbHZlKF9fZGlybmFtZSwgJy4vc3JjJyksXG4gICAgfSxcbiAgfSxcbiAgc2VydmVyOiB7XG4gICAgcG9ydDogNTE3MyxcbiAgICBzdHJpY3RQb3J0OiB0cnVlLFxuICAgIHByb3h5OiB7XG4gICAgICAnL2FwaSc6IHtcbiAgICAgICAgdGFyZ2V0OiAnaHR0cDovL2xvY2FsaG9zdDo4MDAwJyxcbiAgICAgICAgY2hhbmdlT3JpZ2luOiBmYWxzZSxcbiAgICAgIH0sXG4gICAgICAnL3N3LmpzJzoge1xuICAgICAgICB0YXJnZXQ6ICdodHRwOi8vbG9jYWxob3N0OjgwMDAnLFxuICAgICAgICBjaGFuZ2VPcmlnaW46IGZhbHNlLFxuICAgICAgfSxcbiAgICB9LFxuICB9LFxuICBidWlsZDoge1xuICAgIG91dERpcjogJ2Rpc3QnLFxuICAgIGVtcHR5T3V0RGlyOiB0cnVlLFxuICAgIHNvdXJjZW1hcDogZmFsc2UsXG4gICAgLy8gQ2h1bmsgc3RyYXRlZ3k6IHJlYWN0ICsgcmVhY3QtZG9tIGluIHRoZWlyIG93biBjaHVuayBzbyB0aGV5IGdldFxuICAgIC8vIGNhY2hlZCBhY3Jvc3MgZGVwbG95cyB3aGVuIG9ubHkgYXBwIGNvZGUgY2hhbmdlcy5cbiAgICByb2xsdXBPcHRpb25zOiB7XG4gICAgICBvdXRwdXQ6IHtcbiAgICAgICAgbWFudWFsQ2h1bmtzOiB7XG4gICAgICAgICAgcmVhY3Q6IFsncmVhY3QnLCAncmVhY3QtZG9tJywgJ3JlYWN0LXJvdXRlci1kb20nXSxcbiAgICAgICAgICBxdWVyeTogWydAdGFuc3RhY2svcmVhY3QtcXVlcnknXSxcbiAgICAgICAgICBjaGFydHM6IFsncmVjaGFydHMnXSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgfSxcbiAgfSxcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIjtBQUFxWCxTQUFTLG9CQUFvQjtBQUNsWixPQUFPLFdBQVc7QUFDbEIsT0FBTyxVQUFVO0FBRmpCLElBQU0sbUNBQW1DO0FBYXpDLElBQU8sc0JBQVEsYUFBYTtBQUFBLEVBQzFCLE1BQU07QUFBQSxFQUNOLFNBQVMsQ0FBQyxNQUFNLENBQUM7QUFBQSxFQUNqQixTQUFTO0FBQUEsSUFDUCxPQUFPO0FBQUEsTUFDTCxLQUFLLEtBQUssUUFBUSxrQ0FBVyxPQUFPO0FBQUEsSUFDdEM7QUFBQSxFQUNGO0FBQUEsRUFDQSxRQUFRO0FBQUEsSUFDTixNQUFNO0FBQUEsSUFDTixZQUFZO0FBQUEsSUFDWixPQUFPO0FBQUEsTUFDTCxRQUFRO0FBQUEsUUFDTixRQUFRO0FBQUEsUUFDUixjQUFjO0FBQUEsTUFDaEI7QUFBQSxNQUNBLFVBQVU7QUFBQSxRQUNSLFFBQVE7QUFBQSxRQUNSLGNBQWM7QUFBQSxNQUNoQjtBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBQUEsRUFDQSxPQUFPO0FBQUEsSUFDTCxRQUFRO0FBQUEsSUFDUixhQUFhO0FBQUEsSUFDYixXQUFXO0FBQUE7QUFBQTtBQUFBLElBR1gsZUFBZTtBQUFBLE1BQ2IsUUFBUTtBQUFBLFFBQ04sY0FBYztBQUFBLFVBQ1osT0FBTyxDQUFDLFNBQVMsYUFBYSxrQkFBa0I7QUFBQSxVQUNoRCxPQUFPLENBQUMsdUJBQXVCO0FBQUEsVUFDL0IsUUFBUSxDQUFDLFVBQVU7QUFBQSxRQUNyQjtBQUFBLE1BQ0Y7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUNGLENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
