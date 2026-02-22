# AgetnticOS Agentic-Net-Monitoring Project

## Overview

AgetnticOS Agentic-Net-Monitoring is a comprehensive observability stack that provides real-time monitoring, metrics collection, distributed tracing, and alerting capabilities for the AgetnticOS ecosystem. It implements industry-standard monitoring technologies including Prometheus, Grafana, Tempo, and OpenTelemetry to deliver complete visibility into system performance, health, and operational characteristics.

### Key Features
- **Complete Observability Stack** with Prometheus metrics, Grafana dashboards, and Tempo tracing
- **OpenTelemetry Integration** with standardized telemetry data collection and export
- **Pre-configured Dashboards** optimized for AgetnticOS application monitoring
- **Automated Health Checks** with service readiness validation
- **Docker Compose Orchestration** for simplified deployment and management
- **Professional Alerting** with Prometheus-based alerting rules

### Technology Stack
- **Monitoring**: Prometheus for metrics collection and storage
- **Visualization**: Grafana for dashboard creation and data visualization
- **Tracing**: Tempo for distributed tracing storage and analysis
- **Telemetry**: OpenTelemetry Collector for data aggregation and processing
- **Orchestration**: Docker Compose for service management
- **Alerting**: Prometheus Alertmanager integration for notifications

## Architecture Components

### Core Services

#### 1. Prometheus (`prometheus:9090`)
**Purpose**: Metrics collection, storage, and querying engine
**Configuration**: `config/prometheus.yaml`

**Key Features**:
- **Metrics Scraping**: Automated collection from AgetnticOS applications via `/actuator/prometheus`
- **Time Series Storage**: High-performance metrics storage with configurable retention
- **PromQL Query Language**: Powerful querying capabilities for metrics analysis
- **Alert Rules**: Configurable alerting based on metric thresholds and patterns
- **Service Discovery**: Automatic discovery of monitoring targets

**Scrape Configuration**:
```yaml
scrape_configs:
  - job_name: 'agentic-net-node'
    static_configs:
      - targets: ['host.docker.internal:8080']
    metrics_path: '/actuator/prometheus'
    scrape_interval: 15s

  - job_name: 'agentic-net-master'
    static_configs:
      - targets: ['host.docker.internal:8082']
    metrics_path: '/actuator/prometheus'
    scrape_interval: 15s
```

#### 2. Grafana (`grafana:3000`)
**Purpose**: Data visualization and dashboard management platform
**Configuration**: `grafana-provisioning/` directory

**Key Features**:
- **Pre-configured Datasources**: Automatic connection to Prometheus and Tempo
- **Custom Dashboards**: AgetnticOS-specific dashboards for application monitoring
- **User Management**: Secure access with admin/admin default credentials
- **Alert Integration**: Visual alerting with notification channels
- **Plugin Ecosystem**: Extensible with community plugins

**Access Information**:
- **URL**: http://localhost:3000
- **Default Credentials**: admin/admin
- **Dashboards**: Auto-provisioned from `grafana-provisioning/dashboards/`

#### 3. Tempo (`tempo:3200`)
**Purpose**: Distributed tracing backend for trace storage and analysis
**Configuration**: `config/tempo.yaml`

**Key Features**:
- **Trace Storage**: High-performance trace data storage and retrieval
- **OpenTelemetry Integration**: Native support for OTLP trace ingestion
- **Query Interface**: REST API for trace querying and analysis
- **Retention Policies**: Configurable trace retention and cleanup
- **Scalable Architecture**: Designed for high-throughput trace ingestion

**Integration Points**:
- **Ingestion**: Receives traces from OpenTelemetry Collector
- **Grafana Integration**: Provides trace datasource for Grafana
- **AgetnticOS Applications**: Direct integration with Spring Boot tracing

#### 4. OpenTelemetry Collector (`otel-collector:4317/4318`)
**Purpose**: Telemetry data collection, processing, and export hub
**Configuration**: `config/otel-collector-config.yaml`

**Key Features**:
- **Multi-Protocol Support**: OTLP gRPC (4317) and HTTP (4318) endpoints
- **Data Processing**: Filtering, sampling, and enrichment of telemetry data
- **Export Flexibility**: Routes data to multiple backends (Tempo, Prometheus)
- **Performance Optimization**: Batching and compression for efficient data transfer
- **Vendor Agnostic**: Standardized telemetry data collection

**Receiver Configuration**:
```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

exporters:
  otlp:
    endpoint: tempo:4317
    tls:
      insecure: true
```

## Dashboard and Visualization

### Pre-configured Dashboards
The monitoring stack includes professionally designed dashboards optimized for AgetnticOS monitoring:

#### 1. AgetnticOS Application Dashboard
**Purpose**: Core application performance and health monitoring

**Key Metrics Panels**:
- **HTTP Request Metrics**: Request rates, response times, error rates
- **JVM Performance**: Memory usage, garbage collection, thread utilization
- **Database Operations**: Transaction rates, connection pool status
- **Custom Business Metrics**: AgetnticOS-specific operational indicators
- **System Health**: Service uptime, health check status

#### 2. AgetnticOS Infrastructure Dashboard
**Purpose**: System-level monitoring and resource utilization

**Key Metrics Panels**:
- **Container Metrics**: CPU, memory, disk usage for Docker containers
- **Network Performance**: Network I/O, connection statistics
- **Docker Health**: Container status, restart counts, resource limits
- **Host System**: OS-level metrics and resource utilization

#### 3. AgetnticOS Tracing Dashboard
**Purpose**: Distributed tracing analysis and performance profiling

**Key Features**:
- **Trace Timeline View**: End-to-end request agentic visualization
- **Service Dependency Map**: Inter-service communication patterns
- **Latency Analysis**: Performance bottleneck identification
- **Error Correlation**: Trace-to-log correlation for debugging

### Custom Metrics Integration
AgetnticOS applications expose custom metrics through Spring Boot Actuator:

```java
// Custom metrics examples from AgetnticOS applications
@Timed(name = "agenticos.model.operations", description = "Time taken for model operations")
@Counter(name = "agenticos.events.processed", description = "Number of events processed")
@Gauge(name = "agenticos.models.active", description = "Number of active models")
```

## Deployment and Operations

### Quick Start
```bash
# Navigate to monitoring directory
cd /Users/alexejsailer/Developer/AgetnticOS/agentic-net-monitoring

# Start monitoring stack
./start-monitoring.sh

# Verify services are running
docker-compose ps

# Access Grafana
open http://localhost:3000
```

### Automated Startup Script
The `start-monitoring.sh` script provides:
- **Docker Health Check**: Validates Docker daemon availability
- **Service Startup**: Orchestrated service initialization
- **Health Validation**: Post-startup service health verification
- **User Guidance**: Next steps and access information

**Script Features**:
```bash
# Health checks for all services
curl -s http://localhost:9090/-/healthy  # Prometheus
curl -s http://localhost:3000/api/health # Grafana
curl -s http://localhost:3200/ready      # Tempo
```

### Service Management
```bash
# Start all services
docker-compose up -d

# View service status
docker-compose ps

# View service logs
docker-compose logs -f grafana
docker-compose logs -f prometheus

# Stop all services
docker-compose down

# Stop with volume cleanup
docker-compose down -v

# Restart specific service
docker-compose restart prometheus
```

### Testing and Validation
The monitoring stack includes comprehensive testing capabilities:

#### Dashboard Testing (`test-dashboard.sh`)
**Purpose**: Automated dashboard functionality validation

**Test Coverage**:
- **Service Health**: Validates all monitoring services are responsive
- **Datasource Connectivity**: Tests Grafana datasource connections
- **Metric Collection**: Verifies metrics are being collected from AgetnticOS apps
- **Dashboard Rendering**: Validates dashboard panels display data correctly

```bash
# Run dashboard tests
./test-dashboard.sh

# Expected output:
✅ Prometheus is collecting metrics from agentic-net-node
✅ Grafana datasources are configured correctly
✅ AgetnticOS Application Dashboard is responsive
```

## Integration with AgetnticOS Ecosystem

### Spring Boot Application Integration
AgetnticOS applications integrate with the monitoring stack through:

#### OpenTelemetry Configuration
```properties
# Application configuration for telemetry
otel.service.name=agentic-net-node
otel.traces.exporter=otlp
otel.exporter.otlp.endpoint=http://localhost:4317
otel.metrics.exporter=otlp
```

#### Actuator Endpoints
```properties
# Prometheus metrics exposure
management.endpoints.web.exposure.include=health,info,metrics,prometheus
management.endpoint.prometheus.enabled=true
management.metrics.export.prometheus.enabled=true
```

#### Custom Metrics Registration
```java
@Component
public class AgetnticOSMetrics {
    private final MeterRegistry meterRegistry;

    @EventListener
    public void onModelOperation(ModelOperationEvent event) {
        Timer.Sample sample = Timer.start(meterRegistry);
        // ... operation logic ...
        sample.stop(Timer.builder("agenticos.model.operations")
            .tag("operation", event.getType())
            .register(meterRegistry));
    }
}
```

### agentic-net-deployment Integration
The monitoring stack integrates seamlessly with agentic-net-deployment:

#### Profile-based Monitoring
```bash
# Backend profile includes monitoring
./deploy-agenticos.sh backend

# Full-stack profile includes complete monitoring
./deploy-agenticos.sh full-stack

# Monitoring-only profile for external monitoring
./deploy-agenticos.sh monitoring
```

#### Containerized Coordination
- **Network Isolation**: Shared Docker networks for service communication
- **Volume Management**: Persistent storage for metrics and trace data
- **Health Dependencies**: Coordinated startup with health check dependencies
- **Resource Limits**: Configured resource constraints for production deployment

### Development Workflow Integration
The monitoring stack supports comprehensive development workflows:

#### Local Development
```bash
# Start AgetnticOS applications with monitoring
cd /Users/alexejsailer/Developer/AgetnticOS/agentic-net-node
./mvnw spring-boot:run

# Monitor in real-time through Grafana
open http://localhost:3000

# Generate test traffic
curl http://localhost:8080/api/tree
curl http://localhost:8082/api/sessions
```

#### Performance Analysis
- **Trace Analysis**: Use Grafana trace view for performance bottlenecks
- **Metrics Correlation**: Correlate business metrics with system performance
- **Alert Configuration**: Set up alerts for performance degradation
- **Capacity Planning**: Historical metrics for resource planning

## Configuration Management

### Prometheus Configuration (`config/prometheus.yaml`)
```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

rule_files:
  - "/etc/prometheus/alerts/*.yml"

scrape_configs:
  - job_name: 'prometheus'
    static_configs:
      - targets: ['localhost:9090']

alerting:
  alertmanagers:
    - static_configs:
        - targets:
          - alertmanager:9093
```

### Tempo Configuration (`config/tempo.yaml`)
```yaml
server:
  http_listen_port: 3200

distributor:
  receivers:
    otlp:
      protocols:
        grpc:
          endpoint: 0.0.0.0:4317
        http:
          endpoint: 0.0.0.0:4318

storage:
  trace:
    backend: local
    local:
      path: /var/tempo/traces
```

### OpenTelemetry Collector Configuration (`config/otel-collector-config.yaml`)
```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch:

exporters:
  otlp:
    endpoint: tempo:4317
    tls:
      insecure: true

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlp]
```

### Grafana Datasource Provisioning (`grafana-provisioning/datasources/`)
```yaml
apiVersion: 1

datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true

  - name: Tempo
    type: tempo
    access: proxy
    url: http://tempo:3200
```

## Alerting and Notification

### Alert Rules Configuration
Alert rules are defined in `/alerts/` directory and loaded by Prometheus:

#### Application Health Alerts
```yaml
# AgetnticOS Application Health
- alert: AgetnticOSServiceDown
  expr: up{job=~"agentic-net-.*"} == 0
  for: 30s
  labels:
    severity: critical
  annotations:
    summary: "AgetnticOS service {{ $labels.job }} is down"
    description: "{{ $labels.job }} has been down for more than 30 seconds"

- alert: HighErrorRate
  expr: rate(http_requests_total{status=~"5.."}[5m]) > 0.1
  for: 2m
  labels:
    severity: warning
  annotations:
    summary: "High error rate detected"
```

#### Performance Alerts
```yaml
# Performance thresholds
- alert: HighResponseTime
  expr: histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m])) > 2
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "High response time detected"

- alert: HighMemoryUsage
  expr: jvm_memory_used_bytes / jvm_memory_max_bytes > 0.8
  for: 5m
  labels:
    severity: warning
```

### Notification Channels
Grafana supports multiple notification channels:
- **Slack Integration**: Real-time alerts to development channels
- **Email Notifications**: Critical alert email distribution
- **Webhook Integration**: Custom notification endpoints
- **PagerDuty Integration**: Production incident management

## Best Practices for Monitoring

### Metrics Design
1. **Use Semantic Naming**: Clear, descriptive metric names with consistent naming conventions
2. **Appropriate Cardinality**: Avoid high-cardinality labels that impact performance
3. **Business Metrics**: Include business-relevant metrics alongside technical metrics
4. **Standardized Labels**: Consistent labeling across services for correlation

### Dashboard Design
1. **User-Focused Dashboards**: Design dashboards for specific user personas (developers, operators)
2. **Layered Detail**: Summary views with drill-down capabilities
3. **Contextual Information**: Include relevant context and documentation
4. **Performance Optimization**: Efficient queries to avoid dashboard slowdown

### Alerting Strategy
1. **Actionable Alerts**: Only alert on conditions requiring human intervention
2. **Alert Fatigue Prevention**: Careful tuning to avoid false positives
3. **Escalation Policies**: Clear escalation paths for different alert severities
4. **Documentation**: Include runbooks and troubleshooting guidance

### Operational Excellence
1. **Regular Review**: Periodic review of metrics, dashboards, and alerts
2. **Capacity Planning**: Use historical data for infrastructure planning
3. **Performance Baselines**: Establish and monitor performance baselines
4. **Continuous Improvement**: Iterative improvement based on operational experience

This document provides comprehensive understanding of the AgetnticOS agentic-net-monitoring project's observability architecture, monitoring capabilities, integration patterns, and operational procedures for effective AgetnticOS ecosystem monitoring and performance management.