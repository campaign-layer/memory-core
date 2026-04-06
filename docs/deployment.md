# Deployment & Configuration Guide

This guide covers deploying memory-core in various environments with different configurations.

## Quick Start

### Local Development
```bash
git clone <repository>
cd memory-core
npm install
npm run dev
```

### Docker (Recommended)
```bash
docker run -p 7401:7401 memory-core:latest
```

### Production
```bash
npm run build
npm start
```

## Environment Configuration

### Core Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `7401` | HTTP server port |
| `NODE_ENV` | `development` | Environment mode |
| `MEMORY_PROVIDER` | `in-memory` | Memory provider type |
| `LOG_LEVEL` | `info` | Logging verbosity |
| `CORS_ORIGIN` | `*` | CORS allowed origins |

### Provider-Specific Settings

#### File Provider
```bash
export MEMORY_PROVIDER=file
export MEMORY_FILE_PATH=./data/memories.json
export FILE_BACKUP_ENABLED=true
export FILE_BACKUP_INTERVAL=300000  # 5 minutes
```

#### Enhanced Provider
```bash
export MEMORY_PROVIDER=enhanced
export ENHANCED_SIMILARITY_THRESHOLD=0.05
export ENHANCED_MAX_RESULTS=50
export ENHANCED_ENABLE_CACHING=true
export ENHANCED_CACHE_TTL=600000  # 10 minutes
```

#### Dual-Layer Provider
```bash
export MEMORY_PROVIDER=dual-layer
export DUAL_LAYER_MAX_EVENTS=1000
export DUAL_LAYER_MAX_INSIGHTS=500
export DUAL_LAYER_PROCESSING_INTERVAL=30000  # 30 seconds
export DUAL_LAYER_STRATEGIES=semantic,preference,summary
export DUAL_LAYER_EVENT_TTL=7200000  # 2 hours
```

## Docker Deployment

### Basic Setup

**Dockerfile**:
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npm run build
EXPOSE 7401
CMD ["npm", "start"]
```

**Build and Run**:
```bash
docker build -t memory-core .
docker run -d \
  --name memory-core \
  -p 7401:7401 \
  -e MEMORY_PROVIDER=file \
  -e MEMORY_FILE_PATH=/data/memories.json \
  -v $(pwd)/data:/data \
  memory-core
```

### Docker Compose

**docker-compose.yml**:
```yaml
version: '3.8'

services:
  memory-core:
    build: .
    ports:
      - "7401:7401"
    environment:
      - NODE_ENV=production
      - MEMORY_PROVIDER=dual-layer
      - LOG_LEVEL=info
    volumes:
      - ./data:/data
      - ./logs:/app/logs
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:7401/health"]
      interval: 30s
      timeout: 10s
      retries: 3

  # Optional: Add reverse proxy
  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf
      - ./ssl:/etc/nginx/ssl
    depends_on:
      - memory-core
    restart: unless-stopped
```

**Run with Compose**:
```bash
docker-compose up -d
```

## Kubernetes Deployment

### Basic Deployment

**deployment.yaml**:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: memory-core
  labels:
    app: memory-core
spec:
  replicas: 3
  selector:
    matchLabels:
      app: memory-core
  template:
    metadata:
      labels:
        app: memory-core
    spec:
      containers:
      - name: memory-core
        image: memory-core:latest
        ports:
        - containerPort: 7401
        env:
        - name: NODE_ENV
          value: "production"
        - name: MEMORY_PROVIDER
          value: "dual-layer"
        - name: PORT
          value: "7401"
        resources:
          requests:
            memory: "256Mi"
            cpu: "100m"
          limits:
            memory: "512Mi"
            cpu: "500m"
        livenessProbe:
          httpGet:
            path: /health
            port: 7401
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /health
            port: 7401
          initialDelaySeconds: 5
          periodSeconds: 5
---
apiVersion: v1
kind: Service
metadata:
  name: memory-core-service
spec:
  selector:
    app: memory-core
  ports:
    - protocol: TCP
      port: 80
      targetPort: 7401
  type: ClusterIP
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: memory-core-ingress
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
spec:
  rules:
  - host: memory-core.yourdomain.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: memory-core-service
            port:
              number: 80
```

**Deploy**:
```bash
kubectl apply -f deployment.yaml
```

### ConfigMap for Configuration

**configmap.yaml**:
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: memory-core-config
data:
  NODE_ENV: "production"
  MEMORY_PROVIDER: "dual-layer"
  LOG_LEVEL: "info"
  DUAL_LAYER_MAX_EVENTS: "1000"
  DUAL_LAYER_PROCESSING_INTERVAL: "30000"
---
apiVersion: v1
kind: Secret
metadata:
  name: memory-core-secrets
type: Opaque
data:
  # Base64 encoded values
  api-key: "your-api-key-base64"
```

Reference in deployment:
```yaml
envFrom:
- configMapRef:
    name: memory-core-config
- secretRef:
    name: memory-core-secrets
```

## Production Optimizations

### Performance Tuning

**Node.js Optimizations**:
```bash
export NODE_OPTIONS="--max-old-space-size=2048"
export UV_THREADPOOL_SIZE=16
```

**PM2 Configuration** (`ecosystem.config.js`):
```javascript
module.exports = {
  apps: [{
    name: 'memory-core',
    script: 'dist/server.js',
    instances: 'max',
    exec_mode: 'cluster',
    env: {
      NODE_ENV: 'production',
      PORT: 7401
    },
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_file: './logs/combined.log',
    time: true
  }]
};
```

**Start with PM2**:
```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

### Load Balancing

**nginx.conf**:
```nginx
upstream memory_core {
    server 127.0.0.1:7401;
    server 127.0.0.1:7402;
    server 127.0.0.1:7403;
}

server {
    listen 80;
    server_name memory-core.yourdomain.com;

    location / {
        proxy_pass http://memory_core;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        
        # Timeouts
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
}
```

## Monitoring & Logging

### Health Checks

**Basic Health Check**:
```bash
curl -f http://localhost:7401/health
```

**Detailed Health Check**:
```bash
curl http://localhost:7401/health | jq '.'
```

Response:
```json
{
  "status": "healthy",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "uptime": 3600,
  "provider": "dual-layer",
  "memory": {
    "used": "256MB",
    "available": "1GB"
  },
  "performance": {
    "avgResponseTime": 45,
    "requestsPerSecond": 120
  }
}
```

### Logging Configuration

**winston.config.js**:
```javascript
import winston from 'winston';

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'memory-core' },
  transports: [
    new winston.transports.File({ 
      filename: 'logs/error.log', 
      level: 'error' 
    }),
    new winston.transports.File({ 
      filename: 'logs/combined.log' 
    })
  ]
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.simple()
  }));
}

export default logger;
```

### Metrics Collection

**Prometheus Integration**:
```javascript
import client from 'prom-client';

const register = new client.Registry();

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_ms',
  help: 'Duration of HTTP requests in ms',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register]
});

const memoryUsage = new client.Gauge({
  name: 'memory_usage_bytes',
  help: 'Memory usage in bytes',
  registers: [register]
});

// Expose metrics endpoint
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});
```

## Security Configuration

### HTTPS Setup

**SSL with nginx**:
```nginx
server {
    listen 443 ssl http2;
    server_name memory-core.yourdomain.com;

    ssl_certificate /etc/nginx/ssl/cert.pem;
    ssl_certificate_key /etc/nginx/ssl/key.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    location / {
        proxy_pass http://localhost:7401;
        # ... proxy headers
    }
}
```

### API Key Authentication

**Environment Setup**:
```bash
export API_KEY_REQUIRED=true
export API_KEYS="key1,key2,key3"
```

**Request Headers**:
```bash
curl -H "Authorization: Bearer your-api-key" \
     http://localhost:7401/v1/memory/context
```

### CORS Configuration

```javascript
app.use(cors({
  origin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:3000'],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));
```

## Backup & Recovery

### File Provider Backup

**Automated Backup Script**:
```bash
#!/bin/bash
BACKUP_DIR="/backups/memory-core"
DATA_FILE="/data/memories.json"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

mkdir -p $BACKUP_DIR
cp $DATA_FILE $BACKUP_DIR/memories_$TIMESTAMP.json

# Keep only last 30 backups
ls -t $BACKUP_DIR/memories_*.json | tail -n +31 | xargs rm -f
```

**Cron Job**:
```bash
# Backup every hour
0 * * * * /path/to/backup-script.sh
```

### Dual-Layer Provider Backup

**Export Data**:
```bash
curl -X POST http://localhost:7401/v1/memory/export \
  -H "Content-Type: application/json" \
  -d '{"tenantId": "all"}' > backup.json
```

**Restore Data**:
```bash
curl -X POST http://localhost:7401/v1/memory/import \
  -H "Content-Type: application/json" \
  -d @backup.json
```

## Troubleshooting

### Common Issues

1. **Port Already in Use**:
   ```bash
   lsof -i :7401
   kill -9 <PID>
   ```

2. **Memory Leaks**:
   ```bash
   # Monitor memory usage
   ps -p <PID> -o pid,vsz,rss,pmem,comm
   
   # Enable Node.js heap dumps
   export NODE_OPTIONS="--heapsnapshot-signal=SIGUSR2"
   kill -SIGUSR2 <PID>
   ```

3. **High CPU Usage**:
   ```bash
   # Profile with Node.js
   node --prof your-app.js
   node --prof-process isolate-*.log > profile.txt
   ```

4. **Database Connection Issues**:
   ```bash
   # Test connectivity
   curl -f http://localhost:7401/health
   
   # Check logs
   tail -f logs/error.log
   ```

### Performance Debugging

**Enable Debug Logging**:
```bash
export DEBUG=memory-core:*
export LOG_LEVEL=debug
```

**Performance Profiling**:
```bash
npm install -g clinic
clinic doctor -- node dist/server.js
```

**Memory Analysis**:
```bash
node --inspect dist/server.js
# Open chrome://inspect in Chrome
```

## Scaling Considerations

### Horizontal Scaling

- Use stateless providers (avoid file provider)
- Implement session affinity if using in-memory
- Consider shared storage for dual-layer insights
- Use load balancer health checks

### Vertical Scaling

- Monitor memory usage per provider type
- Adjust Node.js heap size
- Consider CPU-intensive operations for dual-layer
- Profile and optimize hot paths

### Database Scaling

- Consider external storage for large deployments
- Implement provider for Redis/MongoDB
- Use read replicas for query-heavy workloads
- Implement caching layers