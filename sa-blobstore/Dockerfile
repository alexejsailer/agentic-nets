# Multi-stage Dockerfile for SA-BLOBSTORE
FROM eclipse-temurin:21-jdk AS build

# Install Maven
RUN apt-get update && apt-get install -y maven && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy pom.xml first for dependency caching
COPY pom.xml .

# Download dependencies (this layer will be cached if pom.xml doesn't change)
RUN mvn dependency:go-offline -B

# Copy source code
COPY src ./src

# Build the application
RUN mvn clean package -DskipTests

# Production stage
FROM eclipse-temurin:21-jre AS production

# Install curl for health checks and create app user for security
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/* && \
    addgroup --system blobstore && adduser --system --ingroup blobstore blobstore

# Create directories
RUN mkdir -p /app/data /app/logs && \
    chown -R blobstore:blobstore /app

# Set working directory
WORKDIR /app

# Copy the JAR from build stage
COPY --from=build /app/target/sa-blobstore-*.jar app.jar
COPY --from=build --chown=blobstore:blobstore /app/target/sa-blobstore-*.jar app.jar

# Switch to non-root user
USER blobstore

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:8080/actuator/health || exit 1

# Environment variables with defaults
ENV JAVA_OPTS="-Xmx512m -Xms256m" \
    SPRING_PROFILES_ACTIVE="docker" \
    STORAGE_PATH="/app/data" \
    NODE_ID="node1" \
    MIN_REPLICAS="1" \
    MAX_REPLICAS="2"

# Run the application
CMD ["sh", "-c", "java $JAVA_OPTS -jar app.jar"]