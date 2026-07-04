## Summary

<!-- Briefly describe what this PR does in 1-3 bullet points -->

-

## Motivation

<!-- What user, operator, or maintainer problem does this solve? -->

-

## Changes

<!-- List the key files/areas changed -->

-

## Risk / compatibility

<!-- Note config changes, API changes, migration concerns, or cross-service impact. Write "None" if not applicable. -->

-

## Test plan

<!-- How did you verify this works? Check all that apply. -->

- [ ] Built affected Java services (`./mvnw clean package -DskipTests`)
- [ ] Built affected TypeScript services (`npm install && npx tsup`)
- [ ] Ran locally via Docker Compose
- [ ] Docker images build successfully
- [ ] Tested integration with other services
- [ ] Documentation-only change

## Checklist

- [ ] I have tested these changes locally
- [ ] My changes follow the [conventional commits](https://www.conventionalcommits.org/) format
- [ ] I have updated documentation where applicable
- [ ] I have considered whether this affects commercial-use licensing or closed-core Docker image behavior
- [ ] I acknowledge this contribution is licensed under [BSL 1.1](LICENSE.md) (converts to Apache 2.0 on 2030-02-22)
