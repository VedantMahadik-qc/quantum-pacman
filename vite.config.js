import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      '/moth-api': {
        target: 'https://api.mothquantum.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/moth-api/, ''),
      },
    },
  },
});
