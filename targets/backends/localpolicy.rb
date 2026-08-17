# frozen_string_literal: true

require 'openssl'
require 'json'

module LocalPolicy
  module_function

  def children(node)
    node.value.is_a?(Array) ? node.value : []
  end

  def walk(node, &block)
    yield node
    children(node).each { |child| walk(child, &block) }
  end

  def name(node)
    values = children(node)
    values[0].value if values[0].is_a?(OpenSSL::ASN1::IA5String)
  end

  def named(root, wanted)
    found = []
    walk(root) { |node| found << node if name(node) == wanted }
    raise "expected one #{wanted}, found #{found.length}" unless found.length == 1
    found[0]
  end

  def decode(bytes)
    root = OpenSSL::ASN1.decode(bytes)
    raise 'LocalPolicy is not canonical DER' unless root.to_der == bytes
    root
  end

  def property_name(node)
    outer = children(node)
    inner = outer.length == 1 ? children(outer[0]) : []
    inner[0].value if inner.length == 2 && inner[0].is_a?(OpenSSL::ASN1::IA5String)
  end

  def property_set(root)
    result = children(named(named(root, 'MANB'), 'MANP'))[1]
    raise 'MANP properties are not a SET' unless result.is_a?(OpenSSL::ASN1::Set)
    result
  end

  def properties(root)
    children(property_set(root)).each_with_object({}) do |node, result|
      key = property_name(node)
      raise 'malformed LocalPolicy property' unless key
      raise "duplicate LocalPolicy property #{key}" if result.key?(key)
      result[key] = node
    end
  end

  def value(root, key)
    property = properties(root)[key]
    return nil unless property
    node = children(children(property)[0])[1]
    case node
    when OpenSSL::ASN1::OctetString then node.value
    when OpenSSL::ASN1::Integer then node.value.to_i
    when OpenSSL::ASN1::Boolean then node.value
    else node.to_der
    end
  end

  def private_property(key, value)
    tag = key.bytes.reduce(0) { |result, byte| (result << 8) | byte }
    OpenSSL::ASN1::ASN1Data.new([OpenSSL::ASN1::Sequence([OpenSSL::ASN1::IA5String(key), value])], tag, :PRIVATE)
  end

  def signature_parts(root)
    im4m = named(root, 'IM4M')
    signed = children(im4m).select { |node| node.is_a?(OpenSSL::ASN1::Set) }
    signature = children(im4m).select { |node| node.is_a?(OpenSSL::ASN1::OctetString) && node.value.bytesize.between?(100, 104) }
    chain = children(im4m).select { |node| node.is_a?(OpenSSL::ASN1::Sequence) && children(node).length == 2 }
    raise 'unexpected IM4M signature shape' unless signed.length == 1 && signature.length == 1 && chain.length == 1
    [signed[0], signature[0], chain[0]]
  end

  def verify_signature(root)
    signed, signature, chain = signature_parts(root)
    certificates = children(chain).map { |node| OpenSSL::X509::Certificate.new(node.to_der) }
    raise 'unexpected certificate chain' unless certificates.length == 2 && certificates[1].verify(certificates[0].public_key)
    raise 'invalid LocalPolicy signature' unless certificates[1].public_key.verify(OpenSSL::Digest::SHA384.new, signature.value, signed.to_der)
  end

  SCALAR = 'e2a4e0e6214106c16637da2d4e3841fc81cfd9ca3c9e201604c7bc2223ecef9e12a463372e0c958ce68f39976568fcae'
  PUBLIC = '045f7389a25ff06b9725a6ebbcbf64477061291f0a9ba5fec65efce865f97510617bc47e72f0dc82a9a18aa88a437c1d46477e3dea3055daf762ad18553bab6ed7d279e88c6e828ea5bf217dc0ef49666e0ae93ff8e24cefe1a6dfec887d932940'
  ORDER = 0xffffffffffffffffffffffffffffffffffffffffffffffffc7634d81f4372ddf581a0db248b0a77aecec196accc52973

  def sign(root)
    signed, signature, = signature_parts(root)
    key = OpenSSL::PKey.read(['3081a40201010430' + SCALAR + 'a00706052b81040022a164036200' + PUBLIC].pack('H*'))
    der = key.sign(OpenSSL::Digest::SHA384.new, signed.to_der)
    r, s = children(OpenSSL::ASN1.decode(der)).map { |part| part.value.to_i }
    s = ORDER - s if s > ORDER / 2
    signature.value = OpenSSL::ASN1::Sequence([OpenSSL::ASN1::Integer(r), OpenSSL::ASN1::Integer(s)]).to_der
  end

  PAIR_FIELDS = %w[vuid lpnh rpnh BORD CEPO CHIP CPRO CSEC ECID SDOM kuid lobo love].freeze

  def verify_pair(main, recovery)
    verify_signature(main)
    verify_signature(recovery)
    PAIR_FIELDS.each { |key| raise "LocalPolicy pair differs at #{key}" unless value(main, key) == value(recovery, key) }
    raise 'invalid vuid' unless value(main, 'vuid')&.bytesize == 16
    %w[lpnh rpnh].each { |key| raise "invalid #{key}" unless value(main, key)&.bytesize == 48 }
  end

  def verify_native(main)
    %w[smb0 smb1 sip2 sip3].each { |key| raise "missing #{key}=true" unless value(main, key) == true }
    %w[sip0 sip1 smb2].each { |key| raise "unexpected #{key}" if properties(main).key?(key) }
    generation = value(main, 'stng')
    raise 'invalid stng' unless generation.is_a?(Integer) && generation.between?(1, (1 << 64) - 1)
    %w[nsih spih].each { |key| raise "invalid #{key}" unless value(main, key)&.bytesize == 48 }
  end
end

abort "usage: #{$PROGRAM_NAME} MAIN RECOVERY VUID LPNH" unless ARGV.length == 4
main_path, recovery_path, expected_vuid, expected_lpnh = ARGV
main_bytes = File.binread(main_path)
recovery_bytes = File.binread(recovery_path)
before = LocalPolicy.decode(main_bytes)
recovery = LocalPolicy.decode(recovery_bytes)
LocalPolicy.verify_pair(before, recovery)
LocalPolicy.verify_native(before)
raise 'LocalPolicy vuid does not match bputil' unless LocalPolicy.value(before, 'vuid').unpack1('H*').casecmp?(expected_vuid.delete('-'))
raise 'LocalPolicy lpnh does not match bputil' unless LocalPolicy.value(before, 'lpnh').unpack1('H*').casecmp?(expected_lpnh)

after = LocalPolicy.decode(main_bytes)
set = LocalPolicy.property_set(after)
values = LocalPolicy.properties(after)
values['sip0'] = LocalPolicy.private_property('sip0', OpenSSL::ASN1::Integer(0x7f))
set.value = values.values.sort_by(&:to_der)
LocalPolicy.sign(after)
LocalPolicy.verify_pair(after, recovery)
raise 'sip0 was not set to 0x7f' unless LocalPolicy.value(after, 'sip0') == 0x7f
old_properties = LocalPolicy.properties(before).transform_values(&:to_der)
new_properties = LocalPolicy.properties(after).transform_values(&:to_der)
changed = (old_properties.keys | new_properties.keys).select { |key| old_properties[key] != new_properties[key] }
raise "unexpected LocalPolicy changes: #{changed.inspect}" unless changed == ['sip0']
raise 'certificate chain changed' unless LocalPolicy.signature_parts(before)[2].to_der == LocalPolicy.signature_parts(after)[2].to_der

bytes = after.to_der
File.open(main_path, 'r+b') do |file|
  file.truncate(0)
  file.write(bytes)
  file.flush
end
raise 'LocalPolicy write did not verify' unless File.binread(main_path) == bytes
raise 'recovery LocalPolicy changed' unless File.binread(recovery_path) == recovery_bytes
puts JSON.generate(ok: true)
