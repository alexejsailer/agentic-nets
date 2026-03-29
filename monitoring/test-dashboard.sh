#!/bin/bash

echo "🔍 AgenticNetOS Dashboard Setup Test"
echo "=============================="

# Check if monitoring stack is running
echo "1. Checking monitoring stack..."

if curl -s http://localhost:9090/-/healthy > /dev/null 2>&1; then
    echo "✅ Prometheus is running (http://localhost:9090)"
else
    echo "❌ Prometheus not running. Run: docker-compose up -d"
    exit 1
fi

if curl -s http://localhost:3000/api/health > /dev/null 2>&1; then
    echo "✅ Grafana is running (http://localhost:3000)"
else
    echo "❌ Grafana not running. Run: docker-compose up -d"
    exit 1
fi

# Check if AgenticNetOS app is running
echo ""
echo "2. Checking AgenticNetOS application..."

if curl -s http://localhost:8080/actuator/health > /dev/null 2>&1; then
    echo "✅ AgenticNetOS application is running (http://localhost:8080)"
    
    # Check metrics endpoint
    METRIC_COUNT=$(curl -s http://localhost:8080/actuator/prometheus | wc -l)
    echo "✅ Metrics endpoint working ($METRIC_COUNT metrics available)"
    
    # Check if Prometheus can scrape the app
    echo ""
    echo "3. Checking Prometheus scraping..."
    sleep 2
    
    if curl -s "http://localhost:9090/api/v1/query?query=up{job=\"agentic-net-node\"}" | grep -q '"value":\[.*,"1"\]'; then
        echo "✅ Prometheus is successfully scraping AgenticNetOS metrics"
    else
        echo "⚠️  Prometheus may not be scraping AgenticNetOS yet (this can take up to 30 seconds)"
        echo "    Check targets: http://localhost:9090/targets"
    fi
    
else
    echo "❌ AgenticNetOS application not running. Run: ./mvnw spring-boot:run"
    echo "    (Make sure to run this in another terminal)"
fi

echo ""
echo "4. Testing sample requests (to generate metrics)..."

for i in {1..5}; do
    curl -s http://localhost:8080/actuator/health > /dev/null && echo -n "." || echo -n "x"
    sleep 0.5
done
echo " Done"

echo ""
echo "📊 Dashboard Access:"
echo "   Grafana:    http://localhost:3000 (admin/admin)"
echo "   Prometheus: http://localhost:9090"
echo "   AgenticNetOS:     http://localhost:8080"

echo ""
echo "🎯 Next Steps:"
echo "   1. Open Grafana: http://localhost:3000"
echo "   2. Go to Dashboards → AgenticNetOS Basic Dashboard"
echo "   3. You should see basic metrics (HTTP requests, memory, CPU)"
echo "   4. Generate more traffic: curl http://localhost:8080/api/tree"