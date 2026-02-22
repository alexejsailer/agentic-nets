#!/bin/bash

# AgetnticOS Monitoring Stack Startup Script

set -e

echo "🚀 Starting AgetnticOS Monitoring Stack..."

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo "❌ Docker is not running. Please start Docker first."
    exit 1
fi

# Start the monitoring stack
echo "📊 Starting monitoring containers..."
docker-compose up -d

# Wait for services to be ready
echo "⏳ Waiting for services to start..."
sleep 10

# Check service status
echo "🔍 Checking service health..."

# Check Prometheus
if curl -s http://localhost:9090/-/healthy > /dev/null; then
    echo "✅ Prometheus is running on http://localhost:9090"
else
    echo "❌ Prometheus is not responding"
fi

# Check Grafana
if curl -s http://localhost:3000/api/health > /dev/null; then
    echo "✅ Grafana is running on http://localhost:3000"
else
    echo "❌ Grafana is not responding"
fi

# Check Tempo
if curl -s http://localhost:3200/ready > /dev/null; then
    echo "✅ Tempo is running on http://localhost:3200"
else
    echo "❌ Tempo is not responding"
fi

echo ""
echo "🎯 Next steps:"
echo "1. Start your AgetnticOS application: ./mvnw spring-boot:run"
echo "2. Open Grafana: http://localhost:3000 (admin/admin)"
echo "3. Navigate to 'Dashboards' → 'AgetnticOS Application Dashboard'"
echo "4. Generate some traffic to see metrics: curl http://localhost:8080/api/tree"
echo ""
echo "📚 For more details, see GRAFANA_DASHBOARD.md"