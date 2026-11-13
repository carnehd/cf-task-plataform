// MockServer: responde aos pedidos dos microserviços com respostas guardadas em ficheiros numa pasta. Um só processo
// serve vários mocks, cada um na sua porta e com a sua pasta. Sem dependências: só o JDK (11 ou mais recente), e não
// precisa de compilar:
//
//   java MockServer.java [porta] [pasta] [--gravar=URL] [--atraso=ms]      um mock (porta 8089 e ./mocks, por omissão)
//   java MockServer.java 8100=pasta-a 8080=pasta-b [...] [--atraso=ms]     vários mocks no mesmo processo
//   java MockServer.java --controlo [--atraso=ms]                         os mocks iniciam e param por comandos (stdin)
//
//   --gravar=URL     modo gravação: reencaminha cada pedido para URL (o serviço verdadeiro), devolve a resposta dele e
//                    guarda-a na pasta, com o nome que o modo normal procura (com vários mocks: 8100=pasta,gravar=URL)
//   --atraso=ms      espera antes de cada resposta (para simular um serviço lento)
//
// --controlo (é assim que a plataforma o usa): uma linha por comando, com os campos separados por tabs.
//   iniciar <porta> <pasta> [gravar=URL]   → @<porta> Mock server em http://localhost:<porta>   ou   @<porta> ERRO <motivo>
//   parar <porta>                           → @<porta> parado
// Escreve PRONTO quando está à espera de comandos, e termina quando a entrada fecha (a plataforma fechou). Com vários
// mocks, cada linha da consola começa por @<porta>.
//
// A pasta: <MÉTODO>/<caminho do pedido>.<extensão>. Os ficheiros leem-se a cada pedido: uma alteração vale logo.
//   GET/utilizadores.json                      GET /utilizadores
//   GET/utilizadores/{id}.json                 GET /utilizadores/<qualquer coisa>   ({{id}} na resposta dá o valor)
//   GET/utilizadores@estado=ATIVO.json         GET /utilizadores?estado=ATIVO       (ganha ao ficheiro sem @)
//   POST/utilizadores.201.json                 POST /utilizadores, responde 201     (sem número: 200)
//   GET/utilizadores/index.json                o mesmo que GET/utilizadores.json
//   ANY/...                                    qualquer método, quando não há ficheiro na pasta do método
//   <ficheiro>.headers                         cabeçalhos extra da resposta, um por linha: "Nome: valor"
// Na resposta (ficheiros de texto e .headers): {{nome}} de um {nome} do caminho, {{query.x}}, {{corpo.campo}} (um campo do
// JSON recebido), {{agora}}, {{agora+300}} (daqui a 300 segundos; também +5m, +2h, +1d, ou -60) e {{uuid}}.
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.BufferedReader;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.PrintStream;
import java.net.BindException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLDecoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

public class MockServer {

    static long delayMs;
    static boolean many; // vários mocks neste processo: cada linha da consola leva @<porta>
    static final Map<Integer, Mock> MOCKS = new ConcurrentHashMap<>();
    static final ExecutorService POOL = Executors.newCachedThreadPool();

    // extensão → Content-Type (só estes ficheiros são respostas; os outros, como um LEIA-ME.md, são ignorados)
    static final Map<String, String> TYPES = Map.ofEntries(
            Map.entry("json", "application/json"), Map.entry("xml", "application/xml"),
            Map.entry("txt", "text/plain"), Map.entry("html", "text/html"), Map.entry("csv", "text/csv"),
            Map.entry("yaml", "application/yaml"), Map.entry("yml", "application/yaml"),
            Map.entry("pdf", "application/pdf"), Map.entry("png", "image/png"), Map.entry("jpg", "image/jpeg"),
            Map.entry("bin", "application/octet-stream"));
    static final Set<String> TEXT = Set.of("json", "xml", "txt", "html", "csv", "yaml", "yml");
    // cabeçalhos que não se passam ao serviço verdadeiro nem de volta (o HttpClient recusa alguns)
    static final Set<String> HOP = Set.of("host", "connection", "content-length", "transfer-encoding", "upgrade",
            "expect", "keep-alive", "te", "trailer", "proxy-connection", "http2-settings", "accept-encoding",
            "content-encoding");
    static final Pattern FILE = Pattern.compile("^(.+?)(?:\\.([1-5][0-9]{2}))?\\.([A-Za-z0-9]+)$");
    static final Pattern AGORA = Pattern.compile("agora(?:([+-]\\d+)([smhd]?))?");
    static final DateTimeFormatter HMS = DateTimeFormatter.ofPattern("HH:mm:ss");
    static final HttpClient CLIENT = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1)
            .followRedirects(HttpClient.Redirect.NEVER).connectTimeout(Duration.ofSeconds(10)).build();

    public static void main(String[] args) throws Exception {
        boolean control = false;
        String recordTo = null;
        List<String> plain = new ArrayList<>();
        List<String> pairs = new ArrayList<>();
        for (String a : args) {
            if (a.equals("--controlo")) control = true;
            else if (a.startsWith("--gravar=")) recordTo = a.substring(9);
            else if (a.startsWith("--atraso=")) delayMs = Long.parseLong(a.substring(9));
            else if (a.equals("-h") || a.equals("--help")) {
                System.out.println("java MockServer.java [porta] [pasta] [--gravar=URL] [--atraso=ms]");
                System.out.println("java MockServer.java 8100=pasta-a 8080=pasta-b [--atraso=ms]");
                System.out.println("java MockServer.java --controlo [--atraso=ms]");
                return;
            } else if (a.matches("^\\d+=.+")) pairs.add(a);
            else plain.add(a);
        }

        if (control) {
            many = true;
            // a plataforma lê a consola em UTF-8, também no Windows
            System.setOut(new PrintStream(new FileOutputStream(FileDescriptor.out), true, StandardCharsets.UTF_8));
            System.setErr(new PrintStream(new FileOutputStream(FileDescriptor.err), true, StandardCharsets.UTF_8));
            System.out.println("PRONTO");
            BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
            String line;
            while ((line = in.readLine()) != null) command(line);
            for (Mock m : MOCKS.values()) m.stop(); // a plataforma fechou: tudo pára
            System.exit(0);
        }

        if (!pairs.isEmpty()) {
            many = true;
            for (String p : pairs) {
                int eq = p.indexOf('=');
                String rest = p.substring(eq + 1);
                String rec = null;
                int g = rest.indexOf(",gravar=");
                if (g >= 0) {
                    rec = rest.substring(g + 8);
                    rest = rest.substring(0, g);
                }
                start(Integer.parseInt(p.substring(0, eq)), rest, rec);
            }
            System.out.println("Ctrl+C para parar.");
            return;
        }

        int port = plain.isEmpty() ? 8089 : Integer.parseInt(plain.get(0));
        start(port, plain.size() > 1 ? plain.get(1) : "mocks", recordTo);
        System.out.println("Ctrl+C para parar.");
    }

    // um comando da plataforma: iniciar <porta> <pasta> [gravar=URL] · parar <porta>
    static void command(String line) {
        String[] f = line.split("\t");
        try {
            if (f[0].equals("iniciar") && f.length >= 3) {
                String rec = f.length > 3 && f[3].startsWith("gravar=") ? f[3].substring(7) : null;
                start(Integer.parseInt(f[1].trim()), f[2], rec);
            } else if (f[0].equals("parar") && f.length >= 2) {
                int port = Integer.parseInt(f[1].trim());
                Mock m = MOCKS.remove(port);
                if (m != null) m.stop();
                System.out.println("@" + port + " parado");
            } else if (!line.isBlank()) {
                System.out.println("Comando desconhecido: " + line);
            }
        } catch (Exception e) {
            System.out.println((f.length > 1 ? "@" + f[1].trim() + " " : "") + "ERRO " + e.getMessage());
        }
    }

    static void start(int port, String dir, String recordTo) {
        Path root = Paths.get(dir).toAbsolutePath().normalize();
        Mock m = new Mock(port, root, recordTo == null || recordTo.isBlank() ? null : recordTo.replaceAll("/+$", ""));
        try {
            Files.createDirectories(root);
            if (MOCKS.containsKey(port)) throw new BindException("já há um mock nesta porta");
            m.start();
            MOCKS.put(port, m);
        } catch (BindException e) {
            m.out("ERRO A porta " + port + " já está em uso: há outro programa (ou outro mock) a escutar nela.");
            return;
        } catch (IOException e) {
            m.out("ERRO " + e.getMessage());
            return;
        }
        long n;
        try (Stream<Path> s = Files.walk(root)) {
            n = s.filter(Files::isRegularFile).filter(p -> parse(p.getFileName().toString()) != null).count();
        } catch (IOException e) {
            n = 0;
        }
        m.out("Mock server em http://localhost:" + port);
        m.out("Pasta: " + root + " (" + n + " resposta" + (n == 1 ? "" : "s") + ")");
        if (m.recordTo != null) m.out("A GRAVAR: cada pedido vai para " + m.recordTo + " e a resposta fica na pasta");
        if (delayMs > 0) m.out("Atraso: " + delayMs + " ms por resposta");
    }

    // ---- um mock: uma porta e uma pasta ----
    static final class Mock {
        final int port;
        final Path root;
        final String recordTo;
        HttpServer server;

        Mock(int port, Path root, String recordTo) {
            this.port = port;
            this.root = root;
            this.recordTo = recordTo;
        }

        void start() throws IOException {
            server = HttpServer.create(new InetSocketAddress(port), 0);
            server.createContext("/", this::handle);
            server.setExecutor(POOL);
            server.start();
        }

        void stop() {
            if (server != null) server.stop(0);
        }

        // uma linha da consola deste mock
        void out(String s) {
            System.out.println(many ? "@" + port + " " + s : s);
        }

        void handle(HttpExchange ex) {
            long t0 = System.nanoTime();
            String method = ex.getRequestMethod().toUpperCase(Locale.ROOT);
            URI uri = ex.getRequestURI();
            String shown = uri.getRawPath() + (uri.getRawQuery() != null ? "?" + uri.getRawQuery() : "");
            byte[] body = null;
            try {
                body = ex.getRequestBody().readAllBytes();
                if (delayMs > 0) Thread.sleep(delayMs);
                if (recordTo != null) {
                    record(ex, method, uri, body, t0, shown);
                    return;
                }
                List<String> segs = segments(uri.getRawPath());
                Map<String, String> query = parseQuery(uri.getRawQuery());
                Match m = find(method, segs, query);
                if (m == null && method.equals("HEAD")) m = find("GET", segs, query); // HEAD: a resposta do GET, sem corpo
                if (m == null) m = find("ANY", segs, query);
                if (m == null) {
                    String suggest = method + "/" + (segs.isEmpty() ? "index" : String.join("/", segs)) + ".json";
                    byte[] out = ("{\"erro\":\"Sem mock para " + method + " " + json(shown) + "\",\"criaOFicheiro\":\""
                            + json(suggest) + "\"}").getBytes(StandardCharsets.UTF_8);
                    send(ex, method, 404, Map.of("Content-Type", "application/json; charset=utf-8"), out);
                    log(method, shown, 404, "sem mock · cria " + suggest, t0, body);
                    return;
                }
                byte[] out = Files.readAllBytes(m.file);
                if (TEXT.contains(m.ext)) out = template(new String(out, StandardCharsets.UTF_8), m.vars, query, body)
                        .getBytes(StandardCharsets.UTF_8);
                Map<String, String> headers = new LinkedHashMap<>();
                headers.put("Content-Type", TYPES.get(m.ext) + (TEXT.contains(m.ext) ? "; charset=utf-8" : ""));
                for (Map.Entry<String, String> h : extraHeaders(m.file).entrySet()) headers.put(h.getKey(), template(h.getValue(), m.vars, query, body));
                send(ex, method, m.status, headers, out);
                log(method, shown, m.status, root.relativize(m.file).toString().replace('\\', '/'), t0, body);
            } catch (Exception e) {
                int status = recordTo != null ? 502 : 500;
                try {
                    byte[] out = ("{\"erro\":\"" + json(String.valueOf(e.getMessage())) + "\"}").getBytes(StandardCharsets.UTF_8);
                    send(ex, method, status, Map.of("Content-Type", "application/json; charset=utf-8"), out);
                } catch (IOException ignored) {
                    // a ligação já fechou
                }
                log(method, shown, status, "erro: " + e, t0, body);
            } finally {
                ex.close();
            }
        }

        Match find(String method, List<String> segs, Map<String, String> query) throws IOException {
            Path base = root.resolve(method);
            if (!Files.isDirectory(base)) return null;
            List<String> s = segs.isEmpty() ? List.of("index") : segs;
            return walk(base, s, 0, new LinkedHashMap<>(), query);
        }

        // modo gravação: pergunta ao serviço verdadeiro e guarda a resposta com o nome que o modo normal procura
        void record(HttpExchange ex, String method, URI uri, byte[] body, long t0, String shown) throws Exception {
            String target = recordTo + uri.getRawPath() + (uri.getRawQuery() != null ? "?" + uri.getRawQuery() : "");
            HttpRequest.Builder rb = HttpRequest.newBuilder(URI.create(target)).timeout(Duration.ofSeconds(60))
                    .method(method, body.length == 0 ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofByteArray(body));
            ex.getRequestHeaders().forEach((k, vals) -> {
                if (!HOP.contains(k.toLowerCase(Locale.ROOT))) vals.forEach(v -> rb.header(k, v));
            });
            HttpResponse<byte[]> res = CLIENT.send(rb.build(), HttpResponse.BodyHandlers.ofByteArray());
            String type = res.headers().firstValue("content-type").orElse("").toLowerCase(Locale.ROOT);
            String ext = type.contains("json") ? "json" : type.contains("xml") ? "xml" : type.contains("html") ? "html"
                    : type.contains("yaml") ? "yaml" : type.startsWith("text/") ? "txt" : res.body().length == 0 ? "json" : "bin";
            List<String> segs = segments(uri.getRawPath());
            if (segs.isEmpty()) segs = List.of("index");
            Path dir = root.resolve(method);
            for (int i = 0; i < segs.size() - 1; i++) dir = dir.resolve(safe(segs.get(i)));
            Map<String, String> q = new TreeMap<>(parseQuery(uri.getRawQuery()));
            StringBuilder name = new StringBuilder(safe(segs.get(segs.size() - 1)));
            if (!q.isEmpty()) {
                name.append('@');
                q.forEach((k, v) -> name.append(safe(k)).append('=').append(safe(v)).append('&'));
                name.setLength(name.length() - 1);
            }
            if (res.statusCode() != 200) name.append('.').append(res.statusCode());
            name.append('.').append(ext);
            Files.createDirectories(dir);
            Path file = dir.resolve(name.toString());
            boolean existed = Files.exists(file);
            Files.write(file, res.body());

            Map<String, String> headers = new LinkedHashMap<>();
            res.headers().map().forEach((k, vals) -> {
                if (!k.startsWith(":") && !HOP.contains(k.toLowerCase(Locale.ROOT)) && !vals.isEmpty()) headers.put(k, vals.get(0));
            });
            send(ex, method, res.statusCode(), headers, res.body());
            log(method, shown, res.statusCode(), (existed ? "gravado de novo em " : "gravado em ") + root.relativize(file).toString().replace('\\', '/'), t0, body);
        }

        void log(String method, String path, int status, String what, long t0, byte[] body) {
            long ms = (System.nanoTime() - t0) / 1_000_000;
            StringBuilder sb = new StringBuilder();
            sb.append('[').append(LocalTime.now().format(HMS)).append("] ").append(method).append(' ').append(path)
                    .append("  ->  ").append(status).append("  ").append(what).append("  (").append(ms).append(" ms)");
            String line = sb.toString();
            if (body != null && body.length > 0) {
                String b = new String(body, StandardCharsets.UTF_8).replaceAll("\\s+", " ");
                // uma só escrita: as linhas de dois pedidos ao mesmo tempo não se misturam
                synchronized (System.out) {
                    out(line);
                    out("           corpo: " + (b.length() > 300 ? b.substring(0, 300) + "…" : b));
                }
            } else {
                out(line);
            }
        }
    }

    // ---- procurar o ficheiro: os nomes exatos antes dos {qualquer}; com @query antes de sem ----
    record Match(Path file, String ext, int status, Map<String, String> vars) {}

    record Name(String name, Map<String, String> query, int status, String ext) {}

    static Name parse(String file) {
        if (file.startsWith(".") || file.endsWith(".headers")) return null;
        Matcher mt = FILE.matcher(file);
        if (!mt.matches()) return null;
        String ext = mt.group(3).toLowerCase(Locale.ROOT);
        if (!TYPES.containsKey(ext)) return null;
        String base = mt.group(1);
        int status = mt.group(2) != null ? Integer.parseInt(mt.group(2)) : 200;
        Map<String, String> q = new LinkedHashMap<>();
        int at = base.indexOf('@');
        if (at >= 0) {
            for (String pair : base.substring(at + 1).split("&")) {
                if (pair.isEmpty()) continue;
                int eq = pair.indexOf('=');
                q.put(eq < 0 ? pair : pair.substring(0, eq), eq < 0 ? "*" : pair.substring(eq + 1));
            }
            base = base.substring(0, at);
        }
        return new Name(base, q, status, ext);
    }

    static Match walk(Path dir, List<String> segs, int i, Map<String, String> vars, Map<String, String> query) throws IOException {
        List<Path> entries = list(dir);
        if (i == segs.size() - 1) {
            Match m = bestFile(entries, segs.get(i), vars, query);
            if (m != null) return m;
            if (segs.get(i).equals("index")) return null;
            List<String> more = new ArrayList<>(segs); // /utilizadores → utilizadores/index.json
            more.add("index");
            return descend(entries, more, i, vars, query);
        }
        return descend(entries, segs, i, vars, query);
    }

    static Match descend(List<Path> entries, List<String> segs, int i, Map<String, String> vars, Map<String, String> query) throws IOException {
        String seg = segs.get(i);
        for (Path d : entries) {
            if (Files.isDirectory(d) && d.getFileName().toString().equals(seg)) {
                Match m = walk(d, segs, i + 1, vars, query);
                if (m != null) return m;
            }
        }
        for (Path d : entries) {
            String n = d.getFileName().toString();
            if (Files.isDirectory(d) && isVar(n)) {
                Map<String, String> v = new LinkedHashMap<>(vars);
                v.put(varName(n), seg);
                Match m = walk(d, segs, i + 1, v, query);
                if (m != null) return m;
            }
        }
        return null;
    }

    static Match bestFile(List<Path> entries, String seg, Map<String, String> vars, Map<String, String> query) {
        Match best = null;
        int bestScore = -1;
        for (Path f : entries) {
            if (!Files.isRegularFile(f)) continue;
            Name n = parse(f.getFileName().toString());
            if (n == null) continue;
            Map<String, String> v = new LinkedHashMap<>(vars);
            int score;
            if (n.name.equals(seg)) score = 2;
            else if (isVar(n.name)) {
                v.put(varName(n.name), seg);
                score = 1;
            } else continue;
            if (!queryMatches(n.query, query)) continue;
            score += 10 * n.query.size();
            if (score > bestScore) {
                bestScore = score;
                best = new Match(f, n.ext, n.status, v);
            }
        }
        return best;
    }

    static boolean queryMatches(Map<String, String> wanted, Map<String, String> query) {
        for (Map.Entry<String, String> w : wanted.entrySet()) {
            String got = query.get(w.getKey());
            if (got == null) return false;
            if (!w.getValue().equals("*") && !w.getValue().equals(got)) return false;
        }
        return true;
    }

    static boolean isVar(String n) {
        return n.length() > 2 && n.startsWith("{") && n.endsWith("}");
    }

    static String varName(String n) {
        return n.substring(1, n.length() - 1);
    }

    static List<Path> list(Path dir) throws IOException {
        try (Stream<Path> s = Files.list(dir)) {
            return s.sorted().toList();
        }
    }

    // ---- a resposta ----
    static String template(String text, Map<String, String> vars, Map<String, String> query, byte[] body) {
        if (!text.contains("{{")) return text;
        String received = body == null ? "" : new String(body, StandardCharsets.UTF_8);
        Matcher mt = Pattern.compile("\\{\\{\\s*([\\w.+-]+)\\s*}}").matcher(text);
        StringBuilder sb = new StringBuilder();
        while (mt.find()) {
            String key = mt.group(1);
            String val;
            Matcher when = AGORA.matcher(key);
            if (when.matches()) val = Instant.now().plusSeconds(offset(when.group(1), when.group(2))).toString();
            else if (key.equals("uuid")) val = UUID.randomUUID().toString();
            else if (key.startsWith("query.")) val = query.getOrDefault(key.substring(6), "");
            else if (key.startsWith("corpo.")) val = field(received, key.substring(6));
            else val = vars.getOrDefault(key, mt.group(0));
            mt.appendReplacement(sb, Matcher.quoteReplacement(val));
        }
        mt.appendTail(sb);
        return sb.toString();
    }

    // {{agora+5m}}: o desvio em segundos (sem unidade: segundos)
    static long offset(String n, String unit) {
        if (n == null) return 0;
        long v = Long.parseLong(n.replace("+", ""));
        return switch (unit == null ? "" : unit) {
            case "m" -> v * 60;
            case "h" -> v * 3600;
            case "d" -> v * 86400;
            default -> v;
        };
    }

    // um campo do JSON recebido, sem biblioteca: a primeira ocorrência de "campo": valor (texto sem aspas, ou o valor tal como está)
    static String field(String json, String name) {
        Matcher mt = Pattern.compile("\"" + Pattern.quote(name) + "\"\\s*:\\s*(\"((?:[^\"\\\\]|\\\\.)*)\"|[^,}\\]\\s]+)").matcher(json);
        if (!mt.find()) return "";
        return mt.group(2) != null ? mt.group(2) : mt.group(1);
    }

    static Map<String, String> extraHeaders(Path file) throws IOException {
        Map<String, String> h = new LinkedHashMap<>();
        Path side = file.resolveSibling(file.getFileName() + ".headers");
        if (!Files.exists(side)) return h;
        for (String line : Files.readAllLines(side, StandardCharsets.UTF_8)) {
            int c = line.indexOf(':');
            if (c > 0 && !line.startsWith("#")) h.put(line.substring(0, c).trim(), line.substring(c + 1).trim());
        }
        return h;
    }

    static void send(HttpExchange ex, String method, int status, Map<String, String> headers, byte[] body) throws IOException {
        headers.forEach((k, v) -> ex.getResponseHeaders().add(k, v));
        boolean empty = body.length == 0 || method.equals("HEAD") || status == 204 || status == 304;
        ex.sendResponseHeaders(status, empty ? -1 : body.length);
        if (!empty) {
            try (OutputStream os = ex.getResponseBody()) {
                os.write(body);
            }
        }
    }

    // ---- utilitários ----
    static List<String> segments(String rawPath) {
        List<String> out = new ArrayList<>();
        if (rawPath == null) return out;
        for (String s : rawPath.split("/")) if (!s.isEmpty()) out.add(URLDecoder.decode(s, StandardCharsets.UTF_8));
        return out;
    }

    static Map<String, String> parseQuery(String raw) {
        Map<String, String> q = new LinkedHashMap<>();
        if (raw == null || raw.isEmpty()) return q;
        for (String pair : raw.split("&")) {
            if (pair.isEmpty()) continue;
            int eq = pair.indexOf('=');
            String k = URLDecoder.decode(eq < 0 ? pair : pair.substring(0, eq), StandardCharsets.UTF_8);
            String v = eq < 0 ? "" : URLDecoder.decode(pair.substring(eq + 1), StandardCharsets.UTF_8);
            q.putIfAbsent(k, v);
        }
        return q;
    }

    // um nome que serve de ficheiro também no Windows
    static String safe(String s) {
        String r = s.replaceAll("[<>:\"/\\\\|?*\\x00-\\x1f]", "_");
        return r.isEmpty() || r.equals(".") || r.equals("..") ? "_" : r;
    }

    static String json(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}
