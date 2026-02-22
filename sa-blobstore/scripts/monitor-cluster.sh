#!/bin/bash

# SA-BLOBSTORE Cluster Monitoring Script
# Monitors the health and status of all cluster nodes

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Default ports
NODE1_PORT=8081
NODE2_PORT=8082
NODE3_PORT=8083
NGINX_PORT=8080

print_help() {
    cat << EOF
SA-BLOBSTORE Cluster Monitoring Script

USAGE:
    $0 [OPTIONS]

OPTIONS:
    -w, --watch             Continuously monitor (refresh every 5 seconds)
    -j, --json              Output health status as JSON
    -s, --stats             Show detailed statistics
    -l, --logs NODE         Show logs for specific node (node1, node2, node3, nginx)
    -f, --follow-logs       Follow logs in real-time
    -h, --help             Show this help

EXAMPLES:
    # One-time health check
    $0

    # Continuous monitoring
    $0 --watch

    # Show detailed stats
    $0 --stats

    # View node1 logs
    $0 --logs node1

    # Follow all logs in real-time
    $0 --follow-logs

EOF
}

log() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

header() {
    echo -e "${CYAN}=== $1 ===${NC}"
}

check_node_health() {
    local node_name=$1
    local port=$2
    
    local health_url="http://localhost:$port/actuator/health"
    local response
    
    if response=$(curl -s --max-time 5 "$health_url" 2>/dev/null); then
        local status=$(echo "$response" | jq -r '.status // "UNKNOWN"' 2>/dev/null || echo "UNKNOWN")
        
        if [[ "$status" == "UP" ]]; then
            success "✓ $node_name (port $port) - $status"
            return 0
        else
            warn "⚠ $node_name (port $port) - $status"
            return 1
        fi
    else
        error "✗ $node_name (port $port) - UNREACHABLE"
        return 1
    fi
}

get_node_stats() {
    local node_name=$1
    local port=$2
    
    local metrics_url="http://localhost:$port/actuator/metrics"
    local info_url="http://localhost:$port/actuator/info"
    
    echo "  Node: $node_name (port $port)"
    
    # Try to get basic metrics
    if curl -s --max-time 3 "$info_url" >/dev/null 2>&1; then
        local info_response=$(curl -s --max-time 3 "$info_url")
        echo "    Info: Available"
    else
        echo "    Info: Not available"
    fi
    
    if curl -s --max-time 3 "$metrics_url" >/dev/null 2>&1; then
        echo "    Metrics: Available"
        
        # Try to get JVM memory usage
        local memory_url="http://localhost:$port/actuator/metrics/jvm.memory.used"
        if memory_response=$(curl -s --max-time 3 "$memory_url" 2>/dev/null); then
            local memory_used=$(echo "$memory_response" | jq -r '.measurements[0].value // "N/A"' 2>/dev/null || echo "N/A")
            echo "    Memory Used: $memory_used bytes"
        fi
        
        # Try to get uptime
        local uptime_url="http://localhost:$port/actuator/metrics/process.uptime"
        if uptime_response=$(curl -s --max-time 3 "$uptime_url" 2>/dev/null); then
            local uptime=$(echo "$uptime_response" | jq -r '.measurements[0].value // "N/A"' 2>/dev/null || echo "N/A")
            echo "    Uptime: $uptime seconds"
        fi
    else
        echo "    Metrics: Not available"
    fi
    
    echo ""
}

show_cluster_status() {
    header "SA-BLOBSTORE Cluster Status"
    echo ""
    
    # Check Docker Compose services
    if command -v docker-compose >/dev/null 2>&1; then
        cd "$PROJECT_ROOT"
        if [[ -f docker-compose.yml ]]; then
            echo "Docker Compose Services:"
            docker-compose ps 2>/dev/null || echo "  No services running or docker-compose not available"
            echo ""
        fi
    fi
    
    # Check node health
    echo "Node Health Status:"
    healthy_nodes=0
    
    if check_node_health "Node 1" $NODE1_PORT; then
        ((healthy_nodes++))
    fi
    
    if check_node_health "Node 2" $NODE2_PORT; then
        ((healthy_nodes++))
    fi
    
    if check_node_health "Node 3" $NODE3_PORT; then
        ((healthy_nodes++))
    fi
    
    # Check load balancer
    echo ""
    echo "Load Balancer Status:"
    if check_node_health "Load Balancer" $NGINX_PORT; then
        success "Load balancer is operational"
    else
        warn "Load balancer may be down"
    fi
    
    echo ""
    echo "Cluster Summary:"
    echo "  Healthy Nodes: $healthy_nodes/3"
    echo "  Cluster Status: $([ $healthy_nodes -ge 2 ] && echo -e "${GREEN}Operational${NC}" || echo -e "${RED}Degraded${NC}")"
    
    return $healthy_nodes
}

show_detailed_stats() {
    header "Detailed Node Statistics"
    echo ""
    
    get_node_stats "Node 1" $NODE1_PORT
    get_node_stats "Node 2" $NODE2_PORT  
    get_node_stats "Node 3" $NODE3_PORT
}

show_logs() {
    local node=$1
    local follow=${2:-false}
    
    cd "$PROJECT_ROOT"
    
    if [[ "$follow" == "true" ]]; then
        if [[ "$node" ]]; then
            log "Following logs for $node..."
            docker-compose logs -f "$node"
        else
            log "Following all logs..."
            docker-compose logs -f
        fi
    else
        if [[ "$node" ]]; then
            log "Showing logs for $node..."
            docker-compose logs --tail=50 "$node"
        else
            log "Showing all logs..."
            docker-compose logs --tail=20
        fi
    fi
}

output_json() {
    local node1_status="DOWN"
    local node2_status="DOWN"
    local node3_status="DOWN"
    local lb_status="DOWN"
    
    # Check each node
    if curl -s --max-time 5 "http://localhost:$NODE1_PORT/actuator/health" >/dev/null 2>&1; then
        node1_status="UP"
    fi
    
    if curl -s --max-time 5 "http://localhost:$NODE2_PORT/actuator/health" >/dev/null 2>&1; then
        node2_status="UP"
    fi
    
    if curl -s --max-time 5 "http://localhost:$NODE3_PORT/actuator/health" >/dev/null 2>&1; then
        node3_status="UP"
    fi
    
    if curl -s --max-time 5 "http://localhost:$NGINX_PORT/health" >/dev/null 2>&1; then
        lb_status="UP"
    fi
    
    cat << EOF
{
  "cluster": {
    "timestamp": "$(date -Iseconds)",
    "nodes": {
      "node1": {
        "port": $NODE1_PORT,
        "status": "$node1_status",
        "url": "http://localhost:$NODE1_PORT"
      },
      "node2": {
        "port": $NODE2_PORT,
        "status": "$node2_status",
        "url": "http://localhost:$NODE2_PORT"
      },
      "node3": {
        "port": $NODE3_PORT,
        "status": "$node3_status",
        "url": "http://localhost:$NODE3_PORT"
      }
    },
    "loadBalancer": {
      "port": $NGINX_PORT,
      "status": "$lb_status",
      "url": "http://localhost:$NGINX_PORT"
    }
  }
}
EOF
}

# Parse command line arguments
WATCH=false
JSON=false
STATS=false
LOGS_NODE=""
FOLLOW_LOGS=false

while [[ $# -gt 0 ]]; do
    case $1 in
        -w|--watch)
            WATCH=true
            shift
            ;;
        -j|--json)
            JSON=true
            shift
            ;;
        -s|--stats)
            STATS=true
            shift
            ;;
        -l|--logs)
            LOGS_NODE="$2"
            shift 2
            ;;
        -f|--follow-logs)
            FOLLOW_LOGS=true
            shift
            ;;
        -h|--help)
            print_help
            exit 0
            ;;
        *)
            error "Unknown option: $1"
            print_help
            exit 1
            ;;
    esac
done

# Change to project root
cd "$PROJECT_ROOT"

# Handle different modes
if [[ "$JSON" == "true" ]]; then
    output_json
    exit 0
fi

if [[ "$LOGS_NODE" || "$FOLLOW_LOGS" == "true" ]]; then
    show_logs "$LOGS_NODE" "$FOLLOW_LOGS"
    exit 0
fi

if [[ "$WATCH" == "true" ]]; then
    log "Starting continuous monitoring (press Ctrl+C to stop)..."
    while true; do
        clear
        show_cluster_status
        if [[ "$STATS" == "true" ]]; then
            echo ""
            show_detailed_stats
        fi
        echo ""
        echo "Refreshing in 5 seconds... (press Ctrl+C to stop)"
        sleep 5
    done
else
    show_cluster_status
    if [[ "$STATS" == "true" ]]; then
        echo ""
        show_detailed_stats
    fi
fi