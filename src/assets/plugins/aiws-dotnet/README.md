# .NET plugin

An IDE-style view in the chat for `dotnet test`, `build`, `publish`, `run`, `restore`, `list package` and EF Core commands, plus analysis cards that extract code structures from the C# / Razor / `.csproj` files that are edited and read.

## What changes in the chat

- **dotnet test (IDE Test Explorer)**: project and target framework (`net8.0`) summaries, passed/failed/skipped counts, success percentage, test cases grouped by `Namespace.ClassName` test class, the status and duration of each test (`✓`/`✗`/`○`), `Expected` / `Actual` assertion diff boxes, the `file:line` location and a collapsible stack trace
- **dotnet build / publish / pack**: compiler errors grouped by file, warning codes, produced outputs and duration
- **dotnet run / watch**: the local addresses being listened on and runtime exceptions
- **dotnet ef**: the created migration, the list of applied migrations and the database update
- **dotnet add/remove/list package, restore, format**: NuGet package tables, the number of restored projects and a formatting summary
- **C# / Razor / project code analysis (`files` and `read`)**: ASP.NET Controller and Minimal API (`MapGet`/`MapPost`) endpoints, SignalR Hub and gRPC services, DI registrations (`AddScoped`/`AddSingleton`/`AddDbContext`), EF Core `DbSet<T>` and migration operations, xUnit/NUnit/MSTest test methods (`[Fact]`, `[Theory]`, `[Test]`), C# `class`/`record`/`interface` definitions, Blazor `@page` routes, `.csproj` `PackageReference` and `TargetFramework` changes
- **Status panel**: a panel above the chat that shows the last test run, the last build and the latest commands

## Installation

Ships with AIWS and is on by default; it can be turned off under **Settings → Plugins**. The plugin uses only the `aiws.conversation` API and has no server code. API: `src/assets/agent-skills/aiws-plugin-development`.
